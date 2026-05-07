import type { ClusterPageInfo, ClusterRow } from "./db.js";
import { fetchBlogPlaceholders } from "./s3.js";

export type AssetType =
  | "cover"
  | "thumbnail"
  | "infographic"
  | "internal"
  | "external"
  | "generic";

export type ImageSource =
  | "s3-shape-A"
  | "db-shape-A"
  | "shape-B"
  | "page_info.cover_image_id"
  | "page_info.cover.image_id"
  | "page_info.thumbnail_image_id"
  | "page_info.thumbnail.image_id"
  | "synthetic-cover"
  | "synthetic-thumbnail";

export interface ImageRecord {
  cluster: ClusterRow;
  asset: AssetType;
  /**
   * Real S3 key when available (Shape A `id=`, Shape B `image_id`,
   * page_info cover/thumbnail keys), or a synthesised stable identifier
   * `blog-images/<cluster_id>-<asset>-<index>` /
   * `cover-images/<cluster_id>` / `thumbnail-images/<cluster_id>`.
   */
  imageId: string;
  description: string;
  aspectRatio: string;
  source: ImageSource;
  /**
   * URL of the *existing* image, when we can derive it cheaply.
   * Cover/thumbnail rows fill this from `page_info.thumbnail`. Inline
   * Shape-A rows leave it undefined — the markdown's placeholder ID
   * doesn't map 1:1 to S3 hashes (verified empirically), so we'd just
   * be 404'ing in the UI. v2 can plumb the real mapping in.
   */
  previewUrl?: string;
}

// Aspect ratios are fixed per asset type (per product spec, 2026-05-07).
// To change them, edit this map — the prompts/templates are background
// concerns, but the aspect ratio is what's actually sent to the image
// generator and surfaced in the UI.
const DEFAULT_ASPECT: Record<AssetType, string> = {
  cover: "1:1",
  thumbnail: "16:9",
  infographic: "16:9",
  internal: "16:9",
  external: "16:9",
  generic: "16:9",
};

export function normalizeImageType(raw: string | undefined): AssetType {
  const v = (raw ?? "").toLowerCase();
  if (v === "cover" || v === "blog_cover" || v === "blog-cover") return "cover";
  if (v === "thumbnail" || v === "thumb") return "thumbnail";
  if (v === "infographic") return "infographic";
  if (v === "internal") return "internal";
  if (v === "external") return "external";
  return "generic";
}

/** "#16:9" / "16:9" / "1:1" → "16:9". Returns null on miss. */
export function parseAspectRatio(context: string | undefined): string | null {
  if (!context) return null;
  const m = /(\d+)\s*:\s*(\d+)/.exec(context);
  if (!m) return null;
  return `${m[1]}:${m[2]}`;
}

function descriptionFor(cluster: ClusterRow): string {
  return (cluster.topic ?? "").trim();
}

// ────────────────────────────────────────────────────────────────────────
// Shape A — <image_requirement> tags (S3 markdown OR page_info::text)
// ────────────────────────────────────────────────────────────────────────

const REQ_TAG_GLOBAL =
  /<image_requirement\b([^>]*)>([\s\S]*?)<\/image_requirement>/gi;

interface RequirementTag {
  attrs: Record<string, string>;
  inner: string;
}

function scanRequirementTags(s: string): RequirementTag[] {
  const out: RequirementTag[] = [];
  for (const m of s.matchAll(REQ_TAG_GLOBAL)) {
    const attrs: Record<string, string> = {};
    for (const a of (m[1] ?? "").matchAll(/(\w[\w-]*)\s*=\s*"([^"]*)"/g)) {
      if (a[1]) attrs[a[1]] = a[2] ?? "";
    }
    out.push({ attrs, inner: (m[2] ?? "").trim() });
  }
  return out;
}

function shapeAToRecords(
  cluster: ClusterRow,
  hits: RequirementTag[],
  source: "s3-shape-A" | "db-shape-A",
): ImageRecord[] {
  return hits.map((h, i) => {
    const asset = normalizeImageType(h.attrs.type);
    const realId = h.attrs.id || h.attrs.image_id;
    const imageId = realId || `blog-images/${cluster.id}-${asset}-${i}`;
    const aspect = parseAspectRatio(h.attrs.context) ?? DEFAULT_ASPECT[asset];
    return {
      cluster,
      asset,
      imageId,
      description: h.inner.replace(/\s+/g, " ").trim(),
      aspectRatio: aspect,
      source,
    };
  });
}

// ────────────────────────────────────────────────────────────────────────
// Shape B — JSON tree walk for { description, image_id|image_type|context }
// ────────────────────────────────────────────────────────────────────────

interface ShapeBHit {
  image_id: string | null;
  image_type: string | null;
  context: string | null;
  description: string | null;
}

function walkShapeB(node: unknown): ShapeBHit[] {
  if (node == null) return [];
  if (Array.isArray(node)) {
    const out: ShapeBHit[] = [];
    for (const v of node) out.push(...walkShapeB(v));
    return out;
  }
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const looksLikeImage =
      typeof obj.description === "string" &&
      (typeof obj.image_id === "string" ||
        typeof obj.image_type === "string" ||
        typeof obj.context === "string");
    const out: ShapeBHit[] = [];
    if (looksLikeImage) {
      out.push({
        image_id: typeof obj.image_id === "string" ? obj.image_id : null,
        image_type: typeof obj.image_type === "string" ? obj.image_type : null,
        context: typeof obj.context === "string" ? obj.context : null,
        description: typeof obj.description === "string" ? obj.description : null,
      });
    }
    for (const v of Object.values(obj)) out.push(...walkShapeB(v));
    return out;
  }
  return [];
}

function shapeBToRecords(cluster: ClusterRow, hits: ShapeBHit[]): ImageRecord[] {
  const out: ImageRecord[] = [];
  hits.forEach((h, i) => {
    const asset = normalizeImageType(h.image_type ?? h.context?.replace(/^#/, ""));
    if (asset === "cover" || asset === "thumbnail") return; // handled separately
    const aspect = parseAspectRatio(h.context ?? undefined) ?? DEFAULT_ASPECT[asset];
    const id = h.image_id || `blog-images/${cluster.id}-${asset}-${i}`;
    out.push({
      cluster,
      asset,
      imageId: id,
      description: (h.description ?? "").trim(),
      aspectRatio: aspect,
      source: "shape-B",
    });
  });
  return out;
}

// ────────────────────────────────────────────────────────────────────────
// Cover / thumbnail — synthesised from cluster.topic with real-key
// preference if page_info exposes one.
// ────────────────────────────────────────────────────────────────────────

function thumbnailUrlOf(pi: ClusterPageInfo): string | undefined {
  const t = pi.thumbnail;
  if (typeof t === "string" && t.length > 0) return t;
  if (t && typeof t === "object") {
    const inner = (t as { url?: unknown }).url;
    if (typeof inner === "string" && inner.length > 0) return inner;
  }
  return undefined;
}

function coverRecord(cluster: ClusterRow): ImageRecord {
  const pi = cluster.page_info ?? {};
  const description = descriptionFor(cluster);
  const aspect = DEFAULT_ASPECT.cover;
  const previewUrl = thumbnailUrlOf(pi);

  if (typeof pi.cover_image_id === "string" && (pi.cover_image_id as string).length > 0) {
    return { cluster, asset: "cover", imageId: pi.cover_image_id as string, description, aspectRatio: aspect, source: "page_info.cover_image_id", previewUrl };
  }
  const coverObj = pi.cover;
  if (coverObj && typeof coverObj === "object") {
    const inner = (coverObj as { image_id?: unknown }).image_id;
    if (typeof inner === "string" && inner.length > 0) {
      return { cluster, asset: "cover", imageId: inner, description, aspectRatio: aspect, source: "page_info.cover.image_id", previewUrl };
    }
  }
  return { cluster, asset: "cover", imageId: `cover-images/${cluster.id}`, description, aspectRatio: aspect, source: "synthetic-cover", previewUrl };
}

function thumbnailRecord(cluster: ClusterRow): ImageRecord {
  const pi = cluster.page_info ?? {};
  const description = descriptionFor(cluster);
  const aspect = DEFAULT_ASPECT.thumbnail;
  const previewUrl = thumbnailUrlOf(pi);

  if (typeof pi.thumbnail_image_id === "string" && (pi.thumbnail_image_id as string).length > 0) {
    return { cluster, asset: "thumbnail", imageId: pi.thumbnail_image_id as string, description, aspectRatio: aspect, source: "page_info.thumbnail_image_id", previewUrl };
  }
  const t = pi.thumbnail;
  if (t && typeof t === "object") {
    const inner = (t as { image_id?: unknown }).image_id;
    if (typeof inner === "string" && inner.length > 0) {
      return { cluster, asset: "thumbnail", imageId: inner, description, aspectRatio: aspect, source: "page_info.thumbnail.image_id", previewUrl };
    }
  }
  return { cluster, asset: "thumbnail", imageId: `thumbnail-images/${cluster.id}`, description, aspectRatio: aspect, source: "synthetic-thumbnail", previewUrl };
}

// ────────────────────────────────────────────────────────────────────────
// Inline-image resolution: S3 → DB Shape A → Shape B
// ────────────────────────────────────────────────────────────────────────

async function inlineRecordsForCluster(
  cluster: ClusterRow,
  stagingSubdomain: string | null,
  cache: Map<string, string | null>,
): Promise<ImageRecord[]> {
  // 1. S3 markdown (canonical source for blog clusters).
  if (stagingSubdomain) {
    let body: string | null;
    if (cache.has(cluster.id)) {
      body = cache.get(cluster.id)!;
    } else {
      try {
        const r = await fetchBlogPlaceholders(stagingSubdomain, cluster.id);
        body = r.body;
        cache.set(cluster.id, body);
      } catch (err) {
        process.stderr.write(
          `pageInfo: S3 fetch failed for cluster=${cluster.id}: ${(err as Error).message}\n`,
        );
        body = null;
        cache.set(cluster.id, null);
      }
    }
    if (body) {
      const tags = scanRequirementTags(body);
      if (tags.length > 0) return shapeAToRecords(cluster, tags, "s3-shape-A");
    }
  }

  // 2. DB Shape A: <image_requirement> tags inside page_info::text
  const piText = JSON.stringify(cluster.page_info ?? {});
  const dbTags = scanRequirementTags(piText);
  if (dbTags.length > 0) return shapeAToRecords(cluster, dbTags, "db-shape-A");

  // 3. Shape B: tree walk for image-shaped objects
  const bHits = walkShapeB(cluster.page_info);
  if (bHits.length > 0) return shapeBToRecords(cluster, bHits);

  return [];
}

// ────────────────────────────────────────────────────────────────────────
// Top-level collector
// ────────────────────────────────────────────────────────────────────────

export interface CollectOptions {
  clusterIds?: Set<string>;
  /**
   * When set, only records whose `imageId` is in the set are kept. The
   * web UI uses this to scope a regen to exactly the images the
   * operator ticked, without accidentally pulling in their unselected
   * siblings within the same cluster.
   */
  imageIds?: Set<string>;
  assetTypes?: Set<AssetType>;
  /** Required to enable S3 fetching for inline images. */
  stagingSubdomain?: string | null;
  /** Optional cross-call cache to avoid duplicate S3 GETs. */
  s3Cache?: Map<string, string | null>;
}

export async function collectImageRecords(
  clusters: ClusterRow[],
  options: CollectOptions = {},
): Promise<ImageRecord[]> {
  const cache = options.s3Cache ?? new Map<string, string | null>();
  const stagingSubdomain = options.stagingSubdomain ?? null;

  const records: ImageRecord[] = [];
  for (const cluster of clusters) {
    if (options.clusterIds && !options.clusterIds.has(cluster.id)) continue;

    const inline = await inlineRecordsForCluster(cluster, stagingSubdomain, cache);
    const rows: ImageRecord[] = [coverRecord(cluster), thumbnailRecord(cluster), ...inline];
    for (const r of rows) {
      if (options.assetTypes && !options.assetTypes.has(r.asset)) continue;
      if (options.imageIds && !options.imageIds.has(r.imageId)) continue;
      records.push(r);
    }
  }
  return records;
}
