// ---------------------------------------------------------------------------
// Webhook store — the shared communication surface between the parent
// web process (which receives POST /webhook/replicate/<token> callbacks
// from Replicate) and CLI subprocesses (which POST'd the prediction
// and now wait for its terminal state).
//
// The channel is a file on the mounted /data volume:
//   <runOutDir()>/webhook-cache/<predictionId>.json
//
// Why disk and not HTTP loopback:
//   * subprocesses can't dial the parent without knowing $PORT
//   * survives parent restarts — if the pod recycles while a
//     prediction is in flight, the webhook can still land, write
//     the file, and the (waiting) subprocess picks it up
//   * one authoritative store, no split-brain between memory + disk
//
// Cache files are tiny (<1 KB) and get swept after RESULT_TTL_MS.
// ---------------------------------------------------------------------------
import { createHash, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runOutDir } from "./runOutDir.js";

export const WEBHOOK_CACHE_DIRNAME = "webhook-cache";

/** How long a stored result stays on disk before the retention pass
 *  reclaims it. Sized generously — a subprocess that comes back late
 *  (network hiccup, backoff) should still find its answer. */
export const RESULT_TTL_MS = 60 * 60 * 1000; // 1h

export interface WebhookResult {
  /** Terminal Replicate status. */
  status: "succeeded" | "failed" | "canceled";
  /** First output URL when status=succeeded. */
  output?: string;
  /** Replicate's error message when status=failed. */
  error?: string;
  /** When the parent received the webhook (ISO-8601). Diagnostics only. */
  receivedAt: string;
}

/**
 * Absolute path where the parent writes / the subprocess reads a
 * given prediction's terminal state.
 */
export function cachePathFor(predictionId: string): string {
  // predictionId is Replicate's opaque id — hex + lowercase letters.
  // Whitelist defensively so a malformed value can't escape the dir.
  const safe = predictionId.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 128);
  return path.join(runOutDir(), WEBHOOK_CACHE_DIRNAME, `${safe}.json`);
}

/** Read the stored result. Returns null when nothing's been written. */
export async function readWebhookResult(
  predictionId: string,
): Promise<WebhookResult | null> {
  try {
    const raw = await fs.readFile(cachePathFor(predictionId), "utf8");
    const parsed = JSON.parse(raw) as WebhookResult;
    if (parsed && typeof parsed.status === "string") return parsed;
    return null;
  } catch {
    // ENOENT is the common case (webhook hasn't fired yet). Any other
    // read error (torn write, corrupt JSON) — treat as still-pending;
    // the fallback timer will kick in if it persists.
    return null;
  }
}

/** Write the terminal state — atomic via write-tmp-then-rename. */
export async function writeWebhookResult(
  predictionId: string,
  result: WebhookResult,
): Promise<void> {
  const target = cachePathFor(predictionId);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(result), "utf8");
  await fs.rename(tmp, target);
}

/**
 * The public URL where Replicate can POST webhooks — usually the
 * Railway domain. Env var PUBLIC_BASE_URL takes precedence; otherwise
 * derive from Railway's auto-set RAILWAY_PUBLIC_DOMAIN. Returns null
 * when neither is set (local dev, no reverse tunnel) — callers should
 * skip the webhook path in that case and fall back to Replicate
 * polling.
 */
export function publicBaseUrl(): string | null {
  const explicit = (process.env.PUBLIC_BASE_URL ?? "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const railway = (process.env.RAILWAY_PUBLIC_DOMAIN ?? "").trim();
  if (railway) return `https://${railway.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  return null;
}

/**
 * Derived path-secret used to authenticate incoming webhook POSTs.
 * We can't sign per-prediction because the prediction id is minted by
 * Replicate AFTER we POST, so instead we use a static, secret-derived
 * URL path suffix. Anyone who knows WEBHOOK_SECRET can compute the
 * same suffix; Replicate stores this URL only in its own outbound-
 * webhook table (HTTPS, no logs of the path suffix in our own stack).
 *
 * SHA256(secret)[:32] rather than the raw secret so the secret itself
 * never appears in a URL a proxy might log.
 */
export function webhookPathToken(): string | null {
  const secret = (process.env.WEBHOOK_SECRET ?? "").trim();
  if (!secret) return null;
  return createHash("sha256").update(secret).digest("hex").slice(0, 32);
}

/**
 * Constant-time verify the URL-path token on an incoming webhook POST.
 * Returns false when secret isn't configured — better to reject
 * webhooks entirely than to accept them unauthenticated.
 */
export function verifyWebhookPathToken(provided: string): boolean {
  const expected = webhookPathToken();
  if (!expected) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The URL Replicate posts to when a prediction reaches a terminal
 * state. Static across all our predictions — Replicate's payload
 * carries the prediction id, so we don't need it in the path.
 * Returns null when public URL or secret is missing; caller then
 * falls back to Replicate polling.
 */
export function buildWebhookUrl(): string | null {
  const base = publicBaseUrl();
  const tok = webhookPathToken();
  if (!base || !tok) return null;
  return `${base}/webhook/replicate/${tok}`;
}

/**
 * Sweep webhook-cache files older than RESULT_TTL_MS. Called from
 * the parent's periodic retention loop so we don't accumulate junk on
 * the volume.
 */
export async function sweepWebhookCache(): Promise<{ deleted: number; bytesFreed: number }> {
  const dir = path.join(runOutDir(), WEBHOOK_CACHE_DIRNAME);
  const now = Date.now();
  let deleted = 0;
  let bytesFreed = 0;
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return { deleted, bytesFreed };
  }
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const p = path.join(dir, n);
    try {
      const st = await fs.stat(p);
      if (now - st.mtimeMs > RESULT_TTL_MS) {
        bytesFreed += st.size;
        await fs.rm(p, { force: true });
        deleted++;
      }
    } catch { /* ignore per-file error */ }
  }
  return { deleted, bytesFreed };
}
