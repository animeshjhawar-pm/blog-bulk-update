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

interface AttemptLog {
  ts_sent: string;
  ts_returned: string;
  elapsed_ms: number;
  outcome: FlexOutcome;
  http_status: number | null;
  attempt: 1 | 2;
  model: string;
  service_tier: "flex";
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
  cost_estimated_usd: number;
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
    const respParts = anyResp?.candidates?.[0]?.content?.parts ?? [];
    const imgPart = respParts.find((p: any) => p.inlineData?.data);
    if (!imgPart) {
      outcome = "error";
      errorMessage = "no inline image data in response";
      await appendLog({
        ts_sent: ts_sent_iso,
        ts_returned: new Date().toISOString(),
        elapsed_ms: elapsed,
        outcome,
        http_status: httpStatus,
        attempt,
        model: FLEX_MODEL,
        service_tier: "flex",
        run_id: params.runId,
        image_id: params.imageId,
        cluster_id: params.clusterId,
        project_id: params.projectId,
        asset_type: params.assetType,
        slug: params.slug,
        bytes: 0,
        mime: null,
        prompt_len: params.prompt.length,
        ref_images: inlineRefs.length,
        error_message: errorMessage,
        cost_estimated_usd: FLEX_UNIT_COST_USD,
      });
      throw new FlexError(errorMessage, outcome, elapsed, httpStatus);
    }
    const bytes = Buffer.from(imgPart.inlineData.data, "base64");
    bytesLen = bytes.length;
    mimeOut = imgPart.inlineData.mimeType ?? "image/png";
    await appendLog({
      ts_sent: ts_sent_iso,
      ts_returned: new Date().toISOString(),
      elapsed_ms: elapsed,
      outcome,
      http_status: httpStatus,
      attempt,
      model: FLEX_MODEL,
      service_tier: "flex",
      run_id: params.runId,
      image_id: params.imageId,
      cluster_id: params.clusterId,
      project_id: params.projectId,
      asset_type: params.assetType,
      slug: params.slug,
      bytes: bytesLen,
      mime: mimeOut,
      prompt_len: params.prompt.length,
      ref_images: inlineRefs.length,
      error_message: null,
      cost_estimated_usd: FLEX_UNIT_COST_USD,
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
      ts_sent: ts_sent_iso,
      ts_returned: new Date().toISOString(),
      elapsed_ms: elapsed,
      outcome,
      http_status: httpStatus,
      attempt,
      model: FLEX_MODEL,
      service_tier: "flex",
      run_id: params.runId,
      image_id: params.imageId,
      cluster_id: params.clusterId,
      project_id: params.projectId,
      asset_type: params.assetType,
      slug: params.slug,
      bytes: 0,
      mime: null,
      prompt_len: params.prompt.length,
      ref_images: inlineRefs.length,
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
