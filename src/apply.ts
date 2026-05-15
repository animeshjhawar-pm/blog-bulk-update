import { promises as fs } from "node:fs";
import path from "node:path";
import axios from "axios";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { resizeToWebpVariants, type ImageVariant } from "./imageResize.js";
import { lookupMediaRegistryForId, type MediaRegistryRow } from "./db.js";
import { loadEnv } from "./env.js";
import type { CsvRowParsed } from "./web-types.js";

/**
 * In-place overwrite model (per operator direction, 2026-05-15):
 *   "we just need to update the asset that is stored against the ID.
 *    No URL changes anywhere, no image or UID changes anywhere, no new
 *    images, new image placeholder is introduced. It's just updation
 *    or force overwrite of already stored S3 bucket of image object."
 *
 * For each image_id we:
 *   1. Look up its existing media_registry row (UUID by id, hash by key
 *      suffix) — this gives us the AUTHORITATIVE S3 key prefix.
 *   2. Resize the new source bytes to the 3 canonical WebP variants.
 *   3. PUT each variant to the SAME key the row already points at.
 *
 * We do NOT insert a new media_registry row, mint a new hash, or
 * mutate page_info. The image_id stays exactly the same.
 *
 * Asset types are NOT gated here — whichever flow originally generated
 * the image (blog-images / generated-images / refined-images / cover /
 * thumbnail), we overwrite at the same key. The single gate is whether
 * a media_registry row exists. If it doesn't (some thumbnails fall in
 * this bucket), we surface a clear error and skip.
 *
 * CDN caching note: the stormbreaker uploader sets
 *   Cache-Control: public, max-age=31536000, immutable
 * because every "new" image lands at a fresh key. With in-place
 * overwrite that header would freeze the OLD bytes at the CDN edge for
 * up to a year. We override with a short TTL so the rewrite becomes
 * visible without a manual CDN purge.
 */

export interface ApplyStep {
  /** 1-indexed order in which the step ran. */
  n: number;
  /** Short name shown in the UI ("lookup media_registry", "resize", …). */
  name: string;
  /** "ok" — step completed. "skipped" — dry-run only, real call not made. "error" — step failed; pipeline halts. */
  status: "ok" | "skipped" | "error";
  /** One-line human-readable detail (key, sizes, would-PUT target, …). */
  detail: string;
}

export interface ApplyResult {
  ok: true;
  /** True when this was a dry-run (no S3 mutation). */
  dry_run: boolean;
  /** The image_id that was applied. Same value, before and after — we don't mint a new id. */
  image_id_old: string;
  /** Echoes image_id_old. Kept for response-shape compatibility with the UI's applyServerResults(). */
  image_id_new: string;
  /** media_registry.key — what we overwrote (or would have, in dry-run). */
  key_prefix: string;
  /** Unchanged urls (we overwrote the bytes at the existing URLs). */
  urls: Record<string, string>;
  /** Sum of all variant byte sizes — for log line. */
  bytes: number;
  elapsed_ms: number;
  /** Step-by-step trace for the UI "what would happen" dialog. */
  steps: ApplyStep[];
}

export interface ApplyError {
  ok: false;
  dry_run: boolean;
  image_id_old: string;
  reason: string;
  /** Steps that ran before the failure, plus the failing step. */
  steps: ApplyStep[];
}

// ────────────────────────────────────────────────────────────────────────
// S3 client. Lazy-init so importing this module on a server without
// AWS env doesn't blow up at boot.
// ────────────────────────────────────────────────────────────────────────
let _s3: S3Client | null = null;
function s3(): S3Client {
  if (_s3) return _s3;
  const env = loadEnv();
  _s3 = new S3Client({
    region: env.AWS_REGION ?? "us-east-1",
    credentials: env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
      : undefined,
  });
  return _s3;
}

// Short TTL on overwrite so the CDN picks up the new bytes within
// minutes. Production CDN respects this. If a faster turnaround is
// needed, add an explicit purge call here (flagged for engineering).
const OVERWRITE_CACHE_CONTROL = "public, max-age=60, must-revalidate";

// ────────────────────────────────────────────────────────────────────────
// Source bytes — prefer the local file (no Replicate URL expiry risk),
// fall back to image_url_new for very fresh rows whose local file may
// not be on disk on this instance.
// ────────────────────────────────────────────────────────────────────────
async function readSourceBytes(row: Pick<CsvRowParsed, "image_local_path" | "image_url_new">): Promise<Buffer> {
  const local = (row.image_local_path ?? "").trim();
  if (local) {
    try {
      const abs = path.resolve(local);
      const root = path.resolve(process.cwd());
      if (abs.startsWith(root)) {
        return await fs.readFile(abs);
      }
    } catch {
      /* fall through */
    }
  }
  const remote = (row.image_url_new ?? "").trim();
  if (!remote) throw new Error("no usable source: both image_local_path and image_url_new are empty");
  const resp = await axios.get<ArrayBuffer>(remote, {
    responseType: "arraybuffer",
    timeout: 60_000,
    validateStatus: () => true,
  });
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`download ${remote} failed: HTTP ${resp.status}`);
  }
  return Buffer.from(resp.data);
}

// ────────────────────────────────────────────────────────────────────────
// One image, in-place. Cluster / run scopes fan out via applyMany.
//
// dryRun: when true, every step runs EXCEPT the final S3 PutObject
// fan-out. We still hit the DB, fetch source bytes, resize to all 3
// WebP variants, and resolve the exact S3 keys — so the operator sees
// the real "what would happen" trace and the real byte sizes, without
// any mutation. This is what powers the per-card "Apply" confirmation
// dialog before AWS write credentials are wired up.
// ────────────────────────────────────────────────────────────────────────
export async function applyOne(args: {
  row: CsvRowParsed;
  dryRun?: boolean;
}): Promise<ApplyResult | ApplyError> {
  const t0 = Date.now();
  const { row, dryRun = false } = args;
  const oldImageId = row.image_id;
  const steps: ApplyStep[] = [];
  const push = (name: string, status: ApplyStep["status"], detail: string) => {
    steps.push({ n: steps.length + 1, name, status, detail });
  };
  const fail = (reason: string): ApplyError => {
    push("error", "error", reason);
    return { ok: false, dry_run: dryRun, image_id_old: oldImageId, reason, steps };
  };

  // 1. Resolve the existing media_registry row — the only authoritative
  //    source of the S3 key we're allowed to overwrite. Without this
  //    row, we have no key to write to and must skip.
  let mr: MediaRegistryRow | null;
  try {
    mr = await lookupMediaRegistryForId(oldImageId);
  } catch (err) {
    return fail(`media_registry lookup failed: ${(err as Error).message}`);
  }
  if (!mr) {
    return fail(
      `no media_registry row for image_id "${oldImageId}" — can't determine which S3 key to overwrite. (Thumbnails and a few orphan UUIDs fall in this bucket; their original upload path needs to be mapped before in-place apply is possible.)`,
    );
  }
  push(
    "lookup media_registry",
    "ok",
    `found row id=${mr.id} key=${mr.key} (urls: ${Object.keys(mr.urls).length} variants)`,
  );

  const env = loadEnv();
  const bucket = env.S3_CONTENT_BUCKET;
  if (!bucket) return fail("S3_CONTENT_BUCKET env is not set");

  // 2. Read source bytes (local first, remote fallback).
  let sourceBytes: Buffer;
  let sourceDescr: string;
  try {
    const local = (row.image_local_path ?? "").trim();
    sourceBytes = await readSourceBytes(row);
    sourceDescr = local
      ? `local file ${local} (${formatBytes(sourceBytes.length)})`
      : `remote URL ${row.image_url_new} (${formatBytes(sourceBytes.length)})`;
  } catch (err) {
    return fail((err as Error).message);
  }
  push("read source bytes", "ok", sourceDescr);

  // 3. Resize to 3 variants.
  let variants: ImageVariant[];
  try {
    variants = await resizeToWebpVariants(sourceBytes);
  } catch (err) {
    return fail(`resize failed: ${(err as Error).message}`);
  }
  push(
    "resize to webp variants",
    "ok",
    variants.map((v) => `${v.width}w=${formatBytes(v.size)}`).join(", "),
  );

  // 4. Reconstruct the absolute S3 key for each variant from the
  //    media_registry key + staging-prefixed `website/<sub>/assets/`.
  //    We derive the staging-subdomain from the existing urls[*] in
  //    the row — it's the only place this is reliably stored without
  //    a second DB hop. Pattern is:
  //      https://<cdn>/website/<sub>/assets/<registry-key>/<size>.webp
  const sampleUrl = Object.values(mr.urls).find((u): u is string => typeof u === "string");
  if (!sampleUrl) return fail("media_registry row has no usable urls — can't recover staging-subdomain");
  const m = sampleUrl.match(/\/(website\/[^/]+\/assets\/[^/].*?)\/\d+\.webp$/);
  if (!m) return fail(`unexpected media_registry url shape "${sampleUrl}" — can't recover S3 key prefix`);
  const s3KeyPrefix = m[1]!; // website/<sub>/assets/<registry-key>
  push("derive S3 key prefix", "ok", `s3://${bucket}/${s3KeyPrefix}`);

  // 5. Overwrite each variant at its EXISTING key — or, in dry-run,
  //    record the would-PUT targets and skip the network call.
  const targets = variants.map((v) => `${s3KeyPrefix}/${v.width}.webp`);
  if (dryRun) {
    push(
      "would PUT to S3 (DRY RUN — no write)",
      "skipped",
      `${targets.length} objects: [${targets.join(", ")}] with Cache-Control: ${OVERWRITE_CACHE_CONTROL}`,
    );
  } else {
    try {
      await Promise.all(
        variants.map((v) =>
          s3().send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: `${s3KeyPrefix}/${v.width}.webp`,
              Body: v.bytes,
              ContentType: "image/webp",
              CacheControl: OVERWRITE_CACHE_CONTROL,
            }),
          ),
        ),
      );
    } catch (err) {
      const e = err as Error & { name?: string; $metadata?: { httpStatusCode?: number } };
      const code = e.name ? `[${e.name}] ` : "";
      const status = e.$metadata?.httpStatusCode ? ` (HTTP ${e.$metadata.httpStatusCode})` : "";
      const hint = e.name === "AccessDenied"
        ? " — IAM principal needs s3:PutObject on this prefix. Click 'Verify S3 access' to run a sentinel probe."
        : e.name === "InvalidAccessKeyId" || e.name === "SignatureDoesNotMatch"
          ? " — credentials are wrong; check AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in the env."
          : e.name === "NoSuchBucket"
            ? ` — bucket '${bucket}' does not exist in region ${env.AWS_REGION ?? "us-east-1"}.`
            : "";
      return fail(`S3 overwrite failed: ${code}${e.message}${status}${hint}`);
    }
    push(
      "PUT to S3",
      "ok",
      `overwrote ${targets.length} objects in s3://${bucket} with Cache-Control: ${OVERWRITE_CACHE_CONTROL}`,
    );
  }

  const bytes = variants.reduce((n, v) => n + v.size, 0);
  return {
    ok: true,
    dry_run: dryRun,
    image_id_old: oldImageId,
    image_id_new: oldImageId, // unchanged — in-place overwrite preserves id
    key_prefix: mr.key,
    urls: mr.urls as Record<string, string>,
    bytes,
    elapsed_ms: Date.now() - t0,
    steps,
  };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

/**
 * Convenience: apply every row in parallel (capped). Cluster + run
 * handlers both go through here.
 */
export async function applyMany(
  rows: CsvRowParsed[],
  opts: { dryRun?: boolean } = {},
): Promise<Array<ApplyResult | ApplyError>> {
  const CONCURRENCY = 5;
  const out: Array<ApplyResult | ApplyError> = new Array(rows.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= rows.length) break;
      out[i] = await applyOne({ row: rows[i]!, dryRun: opts.dryRun });
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));
  return out;
}
