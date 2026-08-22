// ---------------------------------------------------------------------------
// Layer 0 image generation via Gemini Flex tier (gemini-3-pro-image =
// Nano Banana Pro). Same model as our Replicate primary, but routed
// through Google's synchronous Flex tier at ~55% discount ($0.067 vs
// $0.15/image at 1K/2K). Falls through to the existing Replicate/fal
// chain on any non-success outcome — this file makes NO retry decisions
// beyond "try once, on 503 try once more".
//
// Retry / fallthrough contract (owned by generate.ts):
//   - success            → return
//   - 503                → 1 retry with 5s backoff, then throw FlexError
//   - 429 / overloaded   → throw FlexError immediately (fall through)
//   - timeout (300s)     → throw FlexError immediately (fall through)
//   - any other error    → throw FlexError immediately (fall through)
//
// Every attempt is journaled to out/runs/flex-attempts.jsonl regardless
// of outcome, so /stats/flex can aggregate success rate + cost wasted
// on timeouts.
// ---------------------------------------------------------------------------

import { GoogleGenAI } from "@google/genai";
import axios from "axios";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runOutDir } from "./runOutDir.js";

const FLEX_MODEL = process.env.FLEX_MODEL ?? "gemini-3-pro-image";
const FLEX_TIMEOUT_MS = Number(process.env.FLEX_TIMEOUT_MS ?? "300000");
const FLEX_UNIT_COST_USD = 0.067; // 1K/2K image at Flex tier (2026-08 pricing page)

export type FlexOutcome =
  | "success"
  | "timeout"
  | "429"
  | "503"
  | "503_retried_success"
  | "error";

export class FlexError extends Error {
  constructor(
    message: string,
    public readonly outcome: FlexOutcome,
    public readonly elapsedMs: number,
    public readonly httpStatus: number | null,
  ) {
    super(message);
    this.name = "FlexError";
  }
}

export interface FlexParams {
  prompt: string;
  aspectRatio: string;
  imageInput: string[];
  /** For rehost path — Flex bytes land at out/runs/<runId>/images/<imageId>.<ext>. */
  runId?: string;
  imageId: string;
  slug: string;
  /** For logging attribution. */
  projectId?: string;
  clusterId?: string;
  assetType?: string;
}

export interface FlexResult {
  /** file:// URL of the written bytes — downloadImage handles this scheme. */
  image_url: string;
  elapsed_ms: number;
  outcome: "success" | "503_retried_success";
}

interface UsageBreakdown {
  prompt_text_tokens: number;
  prompt_image_inputs: number; // ref_images (Flex bills flat per image input)
  output_image_tokens: number;
  output_text_tokens: number;
  thinking_tokens: number;
  total_tokens: number;
}

interface AttemptLog {
  ts_sent: string;
  ts_returned: string;
  elapsed_ms: number;
  /** Google's own server-side elapsed measure from `Server-Timing` header
   *  (`gfet4t7; dur=<ms>`) — subtracts network + our async overhead so
   *  we can compare "how fast Google was" vs "how long we waited". */
  server_elapsed_ms: number | null;
  outcome: FlexOutcome;
  http_status: number | null;
  attempt: 1 | 2;
  model: string;
  /** `modelVersion` field from the response — proves which underlying
   *  build served the call, not just what we asked for. */
  model_version: string | null;
  service_tier: "flex";
  /** `serviceTier` echoed by Google (usage_metadata.serviceTier /
   *  `x-gemini-service-tier` header) — proves the request WAS served
   *  at Flex tier and didn't get silently upgraded/downgraded. */
  served_tier: string | null;
  /** Google's per-response id — the string to quote in support tickets. */
  response_id: string | null;
  run_id?: string;
  image_id: string;
  cluster_id?: string;
  project_id?: string;
  asset_type?: string;
  slug: string;
  bytes: number;
  mime: string | null;
  prompt_len: number;
  ref_images: number;
  error_message: string | null;
  /** Flat unit-rate estimate ($0.067 for a 1K/2K flex image). Kept as
   *  a fallback; the token-breakdown-based cost below is authoritative. */
  cost_estimated_usd: number;
  /** Authoritative cost computed from response.usageMetadata token
   *  counts × Flex-tier prices. Null when we don't have usageMetadata
   *  (older log rows, timeouts, non-200 responses). */
  cost_authoritative_usd: number | null;
  /** Full usage breakdown for token-level analysis (dashboard renders
   *  each line individually with its own $ contribution). */
  usage: UsageBreakdown | null;
}

// Journal on the mounted VOLUME so /stats/flex + /flex-dashboard
// survive redeploys. The image bytes still land under cwd/out/runs/
// (matching rehost.ts's ephemeral layout) — only this ledger is
// persistent. On Railway runOutDir() = /data/runs; local it's
// <cwd>/out.
const ATTEMPTS_LOG = path.join(runOutDir(), "flex-attempts.jsonl");

async function appendLog(entry: AttemptLog): Promise<void> {
  try {
    await fs.mkdir(path.dirname(ATTEMPTS_LOG), { recursive: true });
    await fs.appendFile(ATTEMPTS_LOG, JSON.stringify(entry) + "\n");
  } catch (err) {
    process.stderr.write(
      `flex: failed to append attempt log (${(err as Error).message})\n`,
    );
  }
}

function classifyError(err: unknown): { outcome: FlexOutcome; status: number | null } {
  if (err instanceof Error && err.message === "FLEX_TIMEOUT") {
    return { outcome: "timeout", status: null };
  }
  const anyErr = err as any;
  const status: number | null =
    anyErr?.status ?? anyErr?.statusCode ?? anyErr?.response?.status ?? null;
  const msg = String(anyErr?.message ?? err ?? "").toLowerCase();
  if (status === 429 || /rate.?limit|resource_exhausted|quota/.test(msg)) {
    return { outcome: "429", status };
  }
  if (status === 503 || /unavailable|overloaded|capacity/.test(msg)) {
    return { outcome: "503", status };
  }
  return { outcome: "error", status };
}

async function fetchInlineImage(url: string): Promise<{ data: string; mimeType: string } | null> {
  try {
    const r = await axios.get<ArrayBuffer>(url, {
      responseType: "arraybuffer",
      timeout: 15_000,
    });
    const mimeType =
      (r.headers["content-type"] as string | undefined)?.split(";")[0]?.trim() ??
      "image/png";
    return { data: Buffer.from(r.data).toString("base64"), mimeType };
  } catch (err) {
    process.stderr.write(
      `flex: failed to fetch reference image ${url}: ${(err as Error).message}\n`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Flex-tier pricing (Google AI docs, "Pricing" page, 2026-08). Update
// only when the pricing page changes — the tokens-to-dollars math
// below cross-checks against Google's per-image sticker rate ($0.067
// = 1120 image tokens × $60/1M).
// ---------------------------------------------------------------------------
const FLEX_PRICING = {
  input_text_per_1m_usd: 1.0,
  input_image_flat_usd: 0.0006, // per image input, per Google's pricing table
  output_text_per_1m_usd: 6.0, // "text and thinking" share this rate
  output_image_per_1m_usd: 60.0, // = ~$0.067 at 1120 tokens/image
} as const;

function computeFlexCostFromUsage(u: UsageBreakdown): number {
  return (
    (u.prompt_text_tokens * FLEX_PRICING.input_text_per_1m_usd) / 1_000_000 +
    u.prompt_image_inputs * FLEX_PRICING.input_image_flat_usd +
    (u.output_text_tokens * FLEX_PRICING.output_text_per_1m_usd) / 1_000_000 +
    (u.thinking_tokens * FLEX_PRICING.output_text_per_1m_usd) / 1_000_000 +
    (u.output_image_tokens * FLEX_PRICING.output_image_per_1m_usd) / 1_000_000
  );
}

/**
 * Pull usageMetadata + response headers out of the SDK response. Returns
 * null for the usage/cost if the response has no usageMetadata (older
 * SDK / non-standard error path).
 */
function extractUsage(anyResp: any, refImages: number): {
  usage: UsageBreakdown | null;
  cost_authoritative: number | null;
  server_elapsed_ms: number | null;
  model_version: string | null;
  served_tier: string | null;
  response_id: string | null;
} {
  const um = anyResp?.usageMetadata;
  const headers = anyResp?.sdkHttpResponse?.headers ?? {};
  const model_version = anyResp?.modelVersion ?? null;
  const response_id = anyResp?.responseId ?? null;

  // "server-timing: gfet4t7; dur=28414" — Google's own elapsed ms.
  const serverTiming = headers["server-timing"] as string | undefined;
  const serverElapsedMs = (() => {
    if (!serverTiming) return null;
    const m = /dur=([0-9]+)/.exec(serverTiming);
    return m && m[1] ? Number(m[1]) : null;
  })();

  const servedTier =
    (um?.serviceTier as string | undefined) ??
    (headers["x-gemini-service-tier"] as string | undefined) ??
    null;

  if (!um) {
    return {
      usage: null,
      cost_authoritative: null,
      server_elapsed_ms: serverElapsedMs,
      model_version,
      served_tier: servedTier,
      response_id,
    };
  }

  const imageOutputTokens =
    (um.candidatesTokensDetails as Array<{ modality?: string; tokenCount?: number }> | undefined)
      ?.filter((d) => d.modality === "IMAGE")
      .reduce((s, d) => s + (d.tokenCount ?? 0), 0) ?? 0;
  const candidateTokens = Number(um.candidatesTokenCount ?? 0);
  const promptTextTokens = Number(um.promptTokenCount ?? 0);
  const thinkingTokens = Number(um.thoughtsTokenCount ?? 0);
  const outputTextTokens = Math.max(0, candidateTokens - imageOutputTokens);

  const usage: UsageBreakdown = {
    prompt_text_tokens: promptTextTokens,
    prompt_image_inputs: refImages,
    output_image_tokens: imageOutputTokens,
    output_text_tokens: outputTextTokens,
    thinking_tokens: thinkingTokens,
    total_tokens: Number(um.totalTokenCount ?? 0),
  };
  return {
    usage,
    cost_authoritative: computeFlexCostFromUsage(usage),
    server_elapsed_ms: serverElapsedMs,
    model_version,
    served_tier: servedTier,
    response_id,
  };
}

function extFromMime(mime: string | null): string {
  if (!mime) return "png";
  if (/jpeg|jpg/i.test(mime)) return "jpg";
  if (/webp/i.test(mime)) return "webp";
  if (/png/i.test(mime)) return "png";
  return "png";
}

function safeBasename(s: string): string {
  return s.replace(/[^a-z0-9._-]+/gi, "_").replace(/_+/g, "_").slice(0, 120);
}

async function singleAttempt(
  ai: GoogleGenAI,
  params: FlexParams,
  attempt: 1 | 2,
): Promise<{ bytes: Buffer; mimeType: string; elapsed_ms: number }> {
  const inlineRefs = (
    await Promise.all((params.imageInput ?? []).map((u) => fetchInlineImage(u)))
  ).filter((x): x is { data: string; mimeType: string } => !!x);

  const parts: any[] = [
    ...inlineRefs.map((ref) => ({
      inlineData: { data: ref.data, mimeType: ref.mimeType },
    })),
    { text: params.prompt },
  ];

  const t_sent = Date.now();
  const ts_sent_iso = new Date(t_sent).toISOString();

  let httpStatus: number | null = null;
  let bytesLen = 0;
  let mimeOut: string | null = null;
  let outcome: FlexOutcome = "success";
  let errorMessage: string | null = null;

  // Base log entry — every appendLog site spreads this and overrides
  // just the fields that differ, so nobody forgets a column when we
  // add one.
  const baseLog = {
    ts_sent: ts_sent_iso,
    attempt,
    model: FLEX_MODEL,
    model_version: null,
    service_tier: "flex" as const,
    served_tier: null,
    response_id: null,
    server_elapsed_ms: null,
    run_id: params.runId,
    image_id: params.imageId,
    cluster_id: params.clusterId,
    project_id: params.projectId,
    asset_type: params.assetType,
    slug: params.slug,
    prompt_len: params.prompt.length,
    ref_images: inlineRefs.length,
    usage: null,
    cost_authoritative_usd: null,
  };

  try {
    const resp = await Promise.race([
      ai.models.generateContent({
        model: FLEX_MODEL,
        contents: [{ role: "user", parts }],
        config: {
          // @ts-expect-error - Flex tier flag; SDK types may lag
          serviceTier: "flex",
          responseModalities: ["IMAGE"],
        },
      }),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("FLEX_TIMEOUT")), FLEX_TIMEOUT_MS),
      ),
    ]);
    const elapsed = Date.now() - t_sent;
    httpStatus = 200;
    const anyResp: any = resp;
    const usageInfo = extractUsage(anyResp, inlineRefs.length);
    const respParts = anyResp?.candidates?.[0]?.content?.parts ?? [];
    const imgPart = respParts.find((p: any) => p.inlineData?.data);
    if (!imgPart) {
      outcome = "error";
      errorMessage = "no inline image data in response";
      await appendLog({
        ...baseLog,
        ts_returned: new Date().toISOString(),
        elapsed_ms: elapsed,
        outcome,
        http_status: httpStatus,
        bytes: 0,
        mime: null,
        error_message: errorMessage,
        cost_estimated_usd: FLEX_UNIT_COST_USD,
        model_version: usageInfo.model_version,
        served_tier: usageInfo.served_tier,
        response_id: usageInfo.response_id,
        server_elapsed_ms: usageInfo.server_elapsed_ms,
        usage: usageInfo.usage,
        cost_authoritative_usd: usageInfo.cost_authoritative,
      });
      throw new FlexError(errorMessage, outcome, elapsed, httpStatus);
    }
    const bytes = Buffer.from(imgPart.inlineData.data, "base64");
    bytesLen = bytes.length;
    mimeOut = imgPart.inlineData.mimeType ?? "image/png";
    await appendLog({
      ...baseLog,
      ts_returned: new Date().toISOString(),
      elapsed_ms: elapsed,
      outcome,
      http_status: httpStatus,
      bytes: bytesLen,
      mime: mimeOut,
      error_message: null,
      cost_estimated_usd: FLEX_UNIT_COST_USD,
      model_version: usageInfo.model_version,
      served_tier: usageInfo.served_tier,
      response_id: usageInfo.response_id,
      server_elapsed_ms: usageInfo.server_elapsed_ms,
      usage: usageInfo.usage,
      cost_authoritative_usd: usageInfo.cost_authoritative,
    });
    return { bytes, mimeType: mimeOut ?? "image/png", elapsed_ms: elapsed };
  } catch (err) {
    if (err instanceof FlexError) throw err;
    const elapsed = Date.now() - t_sent;
    const cls = classifyError(err);
    outcome = cls.outcome;
    httpStatus = cls.status;
    errorMessage = (err as Error)?.message ?? String(err);
    await appendLog({
      ...baseLog,
      ts_returned: new Date().toISOString(),
      elapsed_ms: elapsed,
      outcome,
      http_status: httpStatus,
      bytes: 0,
      mime: null,
      error_message: errorMessage,
      cost_estimated_usd: outcome === "timeout" ? FLEX_UNIT_COST_USD : 0,
    });
    throw new FlexError(errorMessage, outcome, elapsed, httpStatus);
  }
}

export function isFlexEnabled(): boolean {
  return (process.env.FLEX_ENABLED ?? "").toLowerCase() === "true" && !!process.env.GEMINI_API_KEY;
}

/**
 * Try Flex once (with a single 5s-backoff retry ONLY on 503). Any other
 * failure — 429, timeout, malformed response, error — throws FlexError
 * with the outcome classified, so generate.ts can log the fall-through
 * reason without re-parsing the message.
 */
export async function generateImageViaFlex(params: FlexParams): Promise<FlexResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new FlexError("GEMINI_API_KEY not set", "error", 0, null);
  const ai = new GoogleGenAI({ apiKey: key });

  let result: { bytes: Buffer; mimeType: string; elapsed_ms: number };
  let outcome: "success" | "503_retried_success" = "success";

  try {
    result = await singleAttempt(ai, params, 1);
  } catch (err) {
    if (!(err instanceof FlexError) || err.outcome !== "503") throw err;
    process.stderr.write(
      `flex: 503 on attempt 1 (elapsed=${err.elapsedMs}ms) — retrying once in 5s\n`,
    );
    await new Promise((r) => setTimeout(r, 5000));
    result = await singleAttempt(ai, params, 2);
    outcome = "503_retried_success";
  }

  // Match rehost.ts EXACTLY — same ephemeral cwd/out layout — so the
  // subsequent downloadImage() no-op's the copy (source === target).
  const RUNS_ROOT = path.resolve(process.cwd(), "out", "runs");
  const dir = params.runId
    ? path.join(RUNS_ROOT, params.runId, "images")
    : path.join(process.cwd(), "out", "images", params.slug);
  await fs.mkdir(dir, { recursive: true });
  const ext = extFromMime(result.mimeType);
  const target = path.join(dir, `${safeBasename(params.imageId)}.${ext}`);
  await fs.writeFile(target, result.bytes);

  return {
    image_url: `file://${target}`,
    elapsed_ms: result.elapsed_ms,
    outcome,
  };
}

/** For /stats/flex — read + aggregate the JSONL log. */
export async function readFlexAttemptsLog(): Promise<AttemptLog[]> {
  try {
    const raw = await fs.readFile(ATTEMPTS_LOG, "utf8");
    return raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        try {
          return JSON.parse(l) as AttemptLog;
        } catch {
          return null;
        }
      })
      .filter((x): x is AttemptLog => x !== null);
  } catch {
    return [];
  }
}

export { FLEX_UNIT_COST_USD, FLEX_MODEL };
