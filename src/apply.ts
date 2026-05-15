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

export interface ApplyResult {
  ok: true;
  /** The image_id that was applied. Same value, before and after — we don't mint a new id. */
  image_id_old: string;
  /** Echoes image_id_old. Kept for response-shape compatibility with the UI's applyServerResults(). */
  image_id_new: string;
  /** media_registry.key — what we overwrote. */
  key_prefix: string;
  /** Unchanged urls (we overwrote the bytes at the existing URLs). */
  urls: Record<string, string>;
  /** Sum of all variant byte sizes — for log line. */
  bytes: number;
  elapsed_ms: number;
}

export interface ApplyError {
  ok: false;
  image_id_old: string;
  reason: string;
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
// ────────────────────────────────────────────────────────────────────────
export async function applyOne(args: { row: CsvRowParsed }): Promise<ApplyResult | ApplyError> {
  const t0 = Date.now();
  const { row } = args;
  const oldImageId = row.image_id;

  // 1. Resolve the existing media_registry row — the only authoritative
  //    source of the S3 key we're allowed to overwrite. Without this
  //    row, we have no key to write to and must skip.
  let mr: MediaRegistryRow | null;
  try {
    mr = await lookupMediaRegistryForId(oldImageId);
  } catch (err) {
    return { ok: false, image_id_old: oldImageId, reason: `media_registry lookup failed: ${(err as Error).message}` };
  }
  if (!mr) {
    return {
      ok: false,
      image_id_old: oldImageId,
      reason: `no media_registry row for image_id "${oldImageId}" — can't determine which S3 key to overwrite. (Thumbnails and a few orphan UUIDs fall in this bucket; their original upload path needs to be mapped before in-place apply is possible.)`,
    };
  }

  const env = loadEnv();
  const bucket = env.S3_CONTENT_BUCKET;
  if (!bucket) {
    return { ok: false, image_id_old: oldImageId, reason: "S3_CONTENT_BUCKET env is not set" };
  }

  // 2. Read source bytes (local first, remote fallback).
  let sourceBytes: Buffer;
  try {
    sourceBytes = await readSourceBytes(row);
  } catch (err) {
    return { ok: false, image_id_old: oldImageId, reason: (err as Error).message };
  }

  // 3. Resize to 3 variants.
  let variants: ImageVariant[];
  try {
    variants = await resizeToWebpVariants(sourceBytes);
  } catch (err) {
    return { ok: false, image_id_old: oldImageId, reason: `resize failed: ${(err as Error).message}` };
  }

  // 4. Reconstruct the absolute S3 key for each variant from the
  //    media_registry key + staging-prefixed `website/<sub>/assets/`.
  //    We derive the staging-subdomain from the existing urls[*] in
  //    the row — it's the only place this is reliably stored without
  //    a second DB hop. Pattern is:
  //      https://<cdn>/website/<sub>/assets/<registry-key>/<size>.webp
  const sampleUrl = Object.values(mr.urls).find((u): u is string => typeof u === "string");
  if (!sampleUrl) {
    return { ok: false, image_id_old: oldImageId, reason: `media_registry row has no usable urls — can't recover staging-subdomain` };
  }
  const m = sampleUrl.match(/\/(website\/[^/]+\/assets\/[^/].*?)\/\d+\.webp$/);
  if (!m) {
    return { ok: false, image_id_old: oldImageId, reason: `unexpected media_registry url shape "${sampleUrl}" — can't recover S3 key prefix` };
  }
  const s3KeyPrefix = m[1]!; // website/<sub>/assets/<registry-key>

  // 5. Overwrite each variant at its EXISTING key.
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
    return { ok: false, image_id_old: oldImageId, reason: `S3 overwrite failed: ${(err as Error).message}` };
  }

  const bytes = variants.reduce((n, v) => n + v.size, 0);
  return {
    ok: true,
    image_id_old: oldImageId,
    image_id_new: oldImageId, // unchanged — in-place overwrite preserves id
    key_prefix: mr.key,
    urls: mr.urls as Record<string, string>,
    bytes,
    elapsed_ms: Date.now() - t0,
  };
}

/**
 * Convenience: apply every row in parallel (capped). Cluster + run
 * handlers both go through here.
 */
export async function applyMany(rows: CsvRowParsed[]): Promise<Array<ApplyResult | ApplyError>> {
  const CONCURRENCY = 5;
  const out: Array<ApplyResult | ApplyError> = new Array(rows.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= rows.length) break;
      out[i] = await applyOne({ row: rows[i]! });
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));
  return out;
}
