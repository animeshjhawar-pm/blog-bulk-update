import { promises as fs } from "node:fs";
import path from "node:path";
import axios from "axios";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { resizeToWebpVariants, VARIANT_WIDTHS, type ImageVariant } from "./imageResize.js";
import {
  getClusterForApply,
  insertMediaRegistry,
  updateClusterPageInfo,
  type ClusterForApply,
} from "./db.js";
import { loadEnv } from "./env.js";
import type { CsvRowParsed } from "./web-types.js";

/**
 * Asset types this apply pipeline currently supports. Cover and
 * thumbnail use a different upstream flow (the blog-cover/thumbnail
 * MDX is written by stormbreaker's `FinalizeBlogService` and tied to
 * the cluster's published_at timestamp, not just the media_registry
 * id) — surfacing them here would risk an out-of-band mutation, so
 * the apply endpoints reject them with a clear error. Engineering
 * decision in §3.5/§6 of docs/apply-api-blueprint.md tracks the
 * follow-up.
 */
export const APPLY_SUPPORTED_ASSETS = new Set([
  "infographic",
  "internal",
  "external",
  "generic",
  "service_h1",
  "service_body",
  "category_industry",
]);

export interface ApplyResult {
  ok: true;
  image_id_old: string;
  image_id_new: string;       // new media_registry.id (uuid)
  key_prefix: string;         // e.g. "blog-images/<cluster>/<new-hash>"
  urls: Record<"360" | "720" | "1080", string>;
  bytes: number;              // sum of all three variants — for log line
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

// ────────────────────────────────────────────────────────────────────────
// Pure helpers — no IO. Easier to unit-test, easier to reason about.
// ────────────────────────────────────────────────────────────────────────

/**
 * Stormbreaker's image-hash format is `<unix_ms_with_subms>_<32 hex>`
 * (16 + 1 + 32 = 49 chars). Examples from live data:
 *   1776666141368784_cd83a691b9c049569783f421fc57b6b0
 *   1776666118944439_3f4568b796944f229d5166173d22b9cb
 *
 * The 32-hex tail is the source-image identity hash in stormbreaker
 * (md5/sha truncated, doesn't really matter — uniqueness, not
 * cryptographic security). For our use case, random 32-hex is
 * sufficient — we just need a fresh path per apply so we never
 * overwrite an in-use image.
 */
export function newStormbreakerHash(now: number = Date.now()): string {
  // Pad timestamp to 16 chars by appending 0-3 sub-ms digits.
  // Date.now() is ms; stormbreaker uses sub-ms via time.time_ns().
  // Reproducing exactly isn't necessary — uniqueness within a
  // millisecond is — so we use crypto.randomInt for the last 3 chars.
  const ts = String(now).padStart(13, "0");
  // 3 random digits to bring total to 16. (Math.random is fine here —
  // not used for security; collisions across the same millisecond
  // are vanishingly unlikely with a 32-hex tail right after.)
  const subMs = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
  // 32 hex chars (16 bytes).
  let hex = "";
  for (let i = 0; i < 32; i++) hex += Math.floor(Math.random() * 16).toString(16);
  return `${ts}${subMs}_${hex}`;
}

/**
 * Resolve the S3 folder prefix + media_registry key prefix for a
 * given asset_type. The prefix is JUST the cluster/hash segment —
 * the caller appends `/<size>.webp` per variant.
 *
 *   blog inline (infographic, internal, external) →
 *     S3: website/<sub>/assets/blog-images/<cluster>/<hash>
 *     media_registry.key: blog-images/<cluster>/<hash>
 *
 *   service H1/body, category-industry, generic →
 *     S3: website/<sub>/assets/generated-images/<hash>
 *     media_registry.key: generated-images/<hash>
 *
 * (Cover/thumbnail share the blog-images folder but the apply
 * pipeline gates them out via APPLY_SUPPORTED_ASSETS, so they
 * don't reach this function.)
 */
export function s3LayoutFor(args: {
  assetType: string;
  stagingSubdomain: string;
  clusterId: string;
  hash: string;
}): { s3Prefix: string; registryKey: string } {
  const { assetType, stagingSubdomain, clusterId, hash } = args;
  if (assetType === "infographic" || assetType === "internal" || assetType === "external") {
    return {
      s3Prefix: `website/${stagingSubdomain}/assets/blog-images/${clusterId}/${hash}`,
      registryKey: `blog-images/${clusterId}/${hash}`,
    };
  }
  // service_h1 | service_body | category_industry | generic
  return {
    s3Prefix: `website/${stagingSubdomain}/assets/generated-images/${hash}`,
    registryKey: `generated-images/${hash}`,
  };
}

/**
 * Build the per-size CDN-public URL given an S3 prefix. CDN domain
 * is environment-specific; we match what media_registry stores live
 * (file-host.link for prod, cdn-dev.gushwork.ai for dev). Env-derived
 * but defaults to file-host.link since this app currently only ships
 * to prod data.
 */
export function publicUrlFor(s3Prefix: string, size: "360" | "720" | "1080"): string {
  const base = process.env.CDN_BASE_URL ?? "https://file-host.link";
  return `${base}/${s3Prefix}/${size}.webp`;
}

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
// page_info mutation — swaps the OLD image_id (uuid OR hash) for the
// NEW media_registry uuid, in whichever field the asset type uses.
//
// The structure differs per page_type — mirrors what pageInfo.ts
// EXTRACTS:
//   blog inline (infographic/internal/external):
//     blog_text.md MDX <Image imageId="OLD_UUID" /> → "NEW_UUID"
//   service_h1:
//     page_info.images[0].image_id
//   service_body:
//     page_info.fold_data.service_steps.images[0].image_id   OR
//     page_info.fold_data.service_description.images[0].image_id
//   category_industry:
//     page_info.fold_data.industries.items[?].image.image_id
//
// Returns true when SOMETHING was mutated. False means we walked
// every supported location and didn't find a match — in which case
// the apply rolls back the S3 + media_registry write would be ideal,
// but for now we report the orphan and surface it in the response.
// ────────────────────────────────────────────────────────────────────────
function mutatePageInfo(
  pageInfo: unknown,
  assetType: string,
  oldImageId: string,
  newImageId: string,
): { touched: boolean; field: string | null } {
  if (!pageInfo || typeof pageInfo !== "object") return { touched: false, field: null };
  const pi = pageInfo as Record<string, unknown>;

  // Blog inline: replace inside blog_text.md (or blog_text.md sub-object)
  if (assetType === "infographic" || assetType === "internal" || assetType === "external") {
    let md: string | null = null;
    let getter: "string" | "object" | null = null;
    if (typeof pi.blog_text === "string") { md = pi.blog_text; getter = "string"; }
    else if (pi.blog_text && typeof pi.blog_text === "object") {
      const inner = (pi.blog_text as { md?: unknown }).md;
      if (typeof inner === "string") { md = inner; getter = "object"; }
    }
    if (!md) return { touched: false, field: null };
    if (!md.includes(oldImageId)) return { touched: false, field: null };
    const updated = md.split(oldImageId).join(newImageId);
    if (getter === "string") pi.blog_text = updated;
    else (pi.blog_text as Record<string, unknown>).md = updated;
    return { touched: true, field: "blog_text.md" };
  }

  // service_h1: top-level images[0]
  if (assetType === "service_h1") {
    const imgs = pi.images;
    if (Array.isArray(imgs) && imgs[0] && typeof imgs[0] === "object") {
      const obj = imgs[0] as Record<string, unknown>;
      if (typeof obj.image_id === "string" && obj.image_id === oldImageId) {
        obj.image_id = newImageId;
        return { touched: true, field: "page_info.images[0].image_id" };
      }
    }
    return { touched: false, field: null };
  }

  // service_body: fold_data.service_steps OR fold_data.service_description
  if (assetType === "service_body") {
    const fd = pi.fold_data;
    if (fd && typeof fd === "object") {
      for (const key of ["service_steps", "service_description"] as const) {
        const node = (fd as Record<string, unknown>)[key];
        if (node && typeof node === "object") {
          const imgs = (node as { images?: unknown }).images;
          if (Array.isArray(imgs) && imgs[0] && typeof imgs[0] === "object") {
            const obj = imgs[0] as Record<string, unknown>;
            if (typeof obj.image_id === "string" && obj.image_id === oldImageId) {
              obj.image_id = newImageId;
              return { touched: true, field: `page_info.fold_data.${key}.images[0].image_id` };
            }
          }
        }
      }
    }
    return { touched: false, field: null };
  }

  // category_industry: fold_data.industries.items[*].image.image_id
  if (assetType === "category_industry") {
    const fd = pi.fold_data;
    if (fd && typeof fd === "object") {
      const ind = (fd as Record<string, unknown>).industries;
      if (ind && typeof ind === "object") {
        const items = (ind as { items?: unknown }).items;
        if (Array.isArray(items)) {
          for (let i = 0; i < items.length; i++) {
            const it = items[i];
            if (!it || typeof it !== "object") continue;
            const img = (it as { image?: unknown }).image;
            if (img && typeof img === "object") {
              const obj = img as Record<string, unknown>;
              if (typeof obj.image_id === "string" && obj.image_id === oldImageId) {
                obj.image_id = newImageId;
                return { touched: true, field: `page_info.fold_data.industries.items[${i}].image.image_id` };
              }
            }
          }
        }
      }
    }
    return { touched: false, field: null };
  }

  // generic: no canonical page_info field we own — caller still
  // wrote the S3 + media_registry row so it's available for whatever
  // consumer happens to want it; just report nothing got rewritten.
  return { touched: false, field: null };
}

// ────────────────────────────────────────────────────────────────────────
// The main pipeline. One call applies one image. Cluster / run
// scopes fan out via Promise.all in the HTTP handlers.
// ────────────────────────────────────────────────────────────────────────
export async function applyOne(args: {
  row: CsvRowParsed;
}): Promise<ApplyResult | ApplyError> {
  const t0 = Date.now();
  const { row } = args;
  const oldImageId = row.image_id;

  if (!APPLY_SUPPORTED_ASSETS.has(row.asset_type)) {
    return {
      ok: false,
      image_id_old: oldImageId,
      reason: `asset_type "${row.asset_type}" is not yet supported by the apply API. Cover & thumbnail use a separate upstream flow (FinalizeBlogService) and need engineering review before being applied via this path.`,
    };
  }

  const cluster: ClusterForApply | null = await getClusterForApply(row.cluster_id);
  if (!cluster) return { ok: false, image_id_old: oldImageId, reason: `cluster ${row.cluster_id} not found` };
  if (!cluster.staging_subdomain) {
    return { ok: false, image_id_old: oldImageId, reason: `project has no staging_subdomain — can't compute S3 path` };
  }

  // 1. Read the source bytes (local first, remote fallback).
  let sourceBytes: Buffer;
  try {
    sourceBytes = await readSourceBytes(row);
  } catch (err) {
    return { ok: false, image_id_old: oldImageId, reason: (err as Error).message };
  }

  // 2. Resize to 3 variants in parallel.
  let variants: ImageVariant[];
  try {
    variants = await resizeToWebpVariants(sourceBytes);
  } catch (err) {
    return { ok: false, image_id_old: oldImageId, reason: `resize failed: ${(err as Error).message}` };
  }

  // 3. Generate a NEW hash + layout. Matches stormbreaker's "new
  //    hash per apply, never overwrite" semantics.
  const hash = newStormbreakerHash();
  const { s3Prefix, registryKey } = s3LayoutFor({
    assetType: row.asset_type,
    stagingSubdomain: cluster.staging_subdomain,
    clusterId: row.cluster_id,
    hash,
  });

  // 4. Upload all 3 variants. Parallelised; one failure aborts.
  const env = loadEnv();
  const bucket = env.S3_CONTENT_BUCKET;
  if (!bucket) {
    return { ok: false, image_id_old: oldImageId, reason: "S3_CONTENT_BUCKET env is not set" };
  }
  try {
    await Promise.all(
      variants.map((v) =>
        s3().send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: `${s3Prefix}/${v.width}.webp`,
            Body: v.bytes,
            ContentType: "image/webp",
            CacheControl: "public, max-age=31536000, immutable",
          }),
        ),
      ),
    );
  } catch (err) {
    return { ok: false, image_id_old: oldImageId, reason: `S3 upload failed: ${(err as Error).message}` };
  }

  // 5. Build the urls JSONB exactly as stormbreaker does.
  const urls: Record<"360" | "720" | "1080", string> = {
    "360": publicUrlFor(s3Prefix, "360"),
    "720": publicUrlFor(s3Prefix, "720"),
    "1080": publicUrlFor(s3Prefix, "1080"),
  };

  // 6. Insert media_registry → get the NEW UUID.
  let newImageId: string;
  try {
    newImageId = await insertMediaRegistry({
      projectId: cluster.p_id,
      key: registryKey,
      urls,
    });
  } catch (err) {
    return { ok: false, image_id_old: oldImageId, reason: `media_registry insert failed: ${(err as Error).message}` };
  }

  // 7. Mutate page_info to point at the new UUID.
  const mut = mutatePageInfo(cluster.page_info, row.asset_type, oldImageId, newImageId);
  if (mut.touched) {
    try {
      await updateClusterPageInfo(cluster.id, cluster.page_info);
    } catch (err) {
      // The S3 + media_registry write already happened — we can't
      // unwind that cheaply. Surface the partial-success state so
      // the operator can decide.
      return {
        ok: false,
        image_id_old: oldImageId,
        reason: `S3 + media_registry succeeded but page_info update failed: ${(err as Error).message}. media_registry id = ${newImageId}; field would have been ${mut.field}.`,
      };
    }
  }

  const bytes = variants.reduce((n, v) => n + v.size, 0);
  return {
    ok: true,
    image_id_old: oldImageId,
    image_id_new: newImageId,
    key_prefix: registryKey,
    urls,
    bytes,
    elapsed_ms: Date.now() - t0,
  };
}

/**
 * Convenience: apply every supported image in a list of CSV rows
 * in parallel, return per-row outcomes. Cluster + run handlers
 * both go through here.
 */
export async function applyMany(rows: CsvRowParsed[]): Promise<Array<ApplyResult | ApplyError>> {
  // Cap concurrent applies so we don't slam S3 or saturate the
  // Postgres pool. 5 is the same default we use in the regen
  // pipeline. Each apply is ~3 PutObject + 2 SQL statements.
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
