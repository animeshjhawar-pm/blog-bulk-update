import type { ClusterPageInfo, ClusterRow } from "./db.js";
import { lookupImageUrls } from "./db.js";
import { fetchBlogPlaceholders } from "./s3.js";

export type AssetType =
  | "cover"
  | "thumbnail"
  | "infographic"
  | "internal"
  | "external"
  | "generic"
  | "service_h1"
  | "service_body"
  | "category_industry";

/** Page kinds we know how to scope. Anything else is treated as blog. */
export type PageType = "blog" | "service" | "category";

export type ImageSource =
  | "s3-shape-A"
  | "db-shape-A"
  | "shape-B"
  | "page_info.cover_image_id"
  | "page_info.cover.image_id"
  | "page_info.thumbnail_image_id"
  | "page_info.thumbnail.image_id"
  | "synthetic-cover"
  | "synthetic-thumbnail"
  | "page_info.images[0]"
  | "page_info.fold_data.service_steps.images[0]"
  | "page_info.fold_data.industries.items[]";

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

// Aspect ratios are fixed per asset type (per product spec, 2026-05-08):
//   cover     16:9 (the wide hero at the top of a blog page)
//   thumbnail 3:2  (used in feeds + related-blogs widgets)
//   inline blog: the image's own `context` (default 16:9)
//   service H1 / body: 1:1 default (or per-image context)
//   category industry: 1:1 default (or per-image context)
const DEFAULT_ASPECT: Record<AssetType, string> = {
  cover: "16:9",
  thumbnail: "3:2",
  infographic: "16:9",
  internal: "16:9",
  external: "16:9",
  generic: "16:9",
  service_h1: "1:1",
  service_body: "1:1",
  category_industry: "1:1",
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

// ────────────────────────────────────────────────────────────────────────
// Shape MDX — page_info.blog_text.md with <Image imageId="<UUID>" alt="…"/>
// (Sentinel-style template; the UUID maps to media_registry for the
// real CDN URL.)
// ────────────────────────────────────────────────────────────────────────

const MDX_IMAGE_TAG_RE =
  /<Image\b[^>]*?\bimageId\s*=\s*"([^"]+)"[^>]*?(?:alt\s*=\s*"([^"]*)")?[^>]*?\/>/gi;

interface MdxImageTag {
  imageId: string;
  alt: string;
}

function scanMdxImageTags(md: string): MdxImageTag[] {
  const out: MdxImageTag[] = [];
  for (const m of md.matchAll(MDX_IMAGE_TAG_RE)) {
    const imageId = (m[1] ?? "").trim();
    if (!imageId) continue;
    out.push({ imageId, alt: (m[2] ?? "").trim() });
  }
  return out;
}

function blogTextMd(pi: ClusterPageInfo): string | null {
  const bt = pi.blog_text;
  if (typeof bt === "string") return bt;
  if (bt && typeof bt === "object" && typeof (bt as { md?: unknown }).md === "string") {
    return (bt as { md: string }).md;
  }
  return null;
}

/**
 * Convert MDX <Image> tags to ImageRecords. Convention (per the user's
 * spec for Sentinel-style blogs):
 *   1st tag → cover
 *   subsequent tags → infographic
 * (page_info.thumbnail is handled separately by thumbnailRecord.)
 */
function mdxToRecords(cluster: ClusterRow, tags: MdxImageTag[]): ImageRecord[] {
  const out: ImageRecord[] = [];
  tags.forEach((t, i) => {
    const asset: AssetType = i === 0 ? "cover" : "infographic";
    out.push({
      cluster,
      asset,
      imageId: t.imageId,
      description: t.alt,
      aspectRatio: DEFAULT_ASPECT[asset],
      // Reuse the s3-shape-A enum for now — these aren't <image_requirement>
      // tags but they share the same downstream shape (image-id keyed
      // record from page_info content).
      source: "s3-shape-A",
    });
  });
  return out;
}

async function inlineRecordsForCluster(
  cluster: ClusterRow,
  stagingSubdomain: string | null,
  cache: Map<string, string | null>,
): Promise<ImageRecord[]> {
  // 1. S3 markdown (canonical for the IMAGE_PLACEHOLDER flow).
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

  // 3. MDX shape — page_info.blog_text.md with <Image imageId="…"/> tags.
  // This is Sentinel's actual template. Each tag's UUID maps to
  // media_registry for a real CDN URL; the per-cluster classifier
  // below makes the 1st MDX Image the "cover".
  const md = blogTextMd(cluster.page_info ?? {});
  if (md) {
    const mdxTags = scanMdxImageTags(md);
    if (mdxTags.length > 0) return mdxToRecords(cluster, mdxTags);
  }

  // 4. Shape B: tree walk for image-shaped objects
  const bHits = walkShapeB(cluster.page_info);
  if (bHits.length > 0) return shapeBToRecords(cluster, bHits);

  return [];
}

// ────────────────────────────────────────────────────────────────────────
// Service page extractors
// ────────────────────────────────────────────────────────────────────────

interface DataImage {
  image_id?: unknown;
  description?: unknown;
  alt_text?: unknown;
  context?: unknown;
}

function imageFromObject(obj: unknown): DataImage | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as DataImage;
  return o;
}

function recordFromImageObject(args: {
  cluster: ClusterRow;
  asset: AssetType;
  obj: DataImage;
  source: ImageSource;
  fallbackDescription?: string;
}): ImageRecord | null {
  const id = typeof args.obj.image_id === "string" ? args.obj.image_id : null;
  if (!id) return null;
  const desc =
    typeof args.obj.description === "string"
      ? (args.obj.description as string)
      : typeof args.obj.alt_text === "string"
        ? (args.obj.alt_text as string)
        : (args.fallbackDescription ?? "");
  const ctx = typeof args.obj.context === "string" ? args.obj.context : undefined;
  return {
    cluster: args.cluster,
    asset: args.asset,
    imageId: id,
    description: desc.trim(),
    aspectRatio: parseAspectRatio(ctx) ?? DEFAULT_ASPECT[args.asset],
    source: args.source,
  };
}

function serviceRecords(cluster: ClusterRow): ImageRecord[] {
  const pi = cluster.page_info ?? {};
  const out: ImageRecord[] = [];

  // H1: page_info.images[0]
  const imagesArr = Array.isArray(pi.images) ? (pi.images as unknown[]) : null;
  if (imagesArr && imagesArr[0]) {
    const obj = imageFromObject(imagesArr[0]);
    if (obj) {
      const r = recordFromImageObject({
        cluster,
        asset: "service_h1",
        obj,
        source: "page_info.images[0]",
        fallbackDescription: cluster.topic ?? "",
      });
      if (r) out.push(r);
    }
  }

  // Body: page_info.fold_data.service_steps.images[0]
  const fold = pi.fold_data;
  if (fold && typeof fold === "object") {
    const steps = (fold as Record<string, unknown>).service_steps;
    if (steps && typeof steps === "object") {
      const stepsImgs = (steps as { images?: unknown }).images;
      if (Array.isArray(stepsImgs) && stepsImgs[0]) {
        const obj = imageFromObject(stepsImgs[0]);
        if (obj) {
          const r = recordFromImageObject({
            cluster,
            asset: "service_body",
            obj,
            source: "page_info.fold_data.service_steps.images[0]",
            fallbackDescription: cluster.topic ?? "",
          });
          if (r) out.push(r);
        }
      }
    }
  }

  return out;
}

// ────────────────────────────────────────────────────────────────────────
// Category page extractor
// ────────────────────────────────────────────────────────────────────────

function categoryRecords(cluster: ClusterRow): ImageRecord[] {
  const pi = cluster.page_info ?? {};
  const fold = pi.fold_data;
  if (!fold || typeof fold !== "object") return [];

  const industries = (fold as Record<string, unknown>).industries;
  if (!industries || typeof industries !== "object") return [];

  const items = (industries as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];

  const out: ImageRecord[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const it = item as { image?: unknown; name?: unknown };

    // Per spec: each item's image lives at item.image (description on the
    // image object). Some templates nest under item.images[0] instead —
    // tolerate both shapes.
    const imgCandidate = it.image ?? (Array.isArray((it as { images?: unknown[] }).images) ? (it as { images: unknown[] }).images[0] : null);
    const obj = imageFromObject(imgCandidate);
    if (!obj) continue;

    const fallback = typeof it.name === "string" ? (it.name as string) : (cluster.topic ?? "");
    const r = recordFromImageObject({
      cluster,
      asset: "category_industry",
      obj,
      source: "page_info.fold_data.industries.items[]",
      fallbackDescription: fallback,
    });
    if (r) out.push(r);
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────
// Top-level collector
// ────────────────────────────────────────────────────────────────────────

export interface CollectOptions {
  /** Defaults to "blog" for backward compatibility. */
  pageType?: PageType;
  clusterIds?: Set<string>;
  /**
   * When set, only records whose `imageId` is in the set are kept. The
   * web UI uses this to scope a regen to exactly the images the
   * operator ticked, without accidentally pulling in their unselected
   * siblings within the same cluster.
   */
  imageIds?: Set<string>;
  assetTypes?: Set<AssetType>;
  /** Required to enable S3 fetching for inline images on blog pages. */
  stagingSubdomain?: string | null;
  /** Optional cross-call cache to avoid duplicate S3 GETs. */
  s3Cache?: Map<string, string | null>;
}

/**
 * Warm the per-cluster S3 markdown cache in parallel BEFORE
 * collectImageRecords runs. The cache map is keyed by cluster.id and
 * holds either the markdown body string or null (404 / unreachable).
 * inlineRecordsForCluster checks the cache before issuing its own
 * fetch, so warming it up front converts a sequential workload into
 * a parallel one — workspace-level wall time drops from O(N) to
 * O(N / concurrency).
 */
export async function prefetchBlogMarkdowns(
  clusters: ClusterRow[],
  stagingSubdomain: string | null,
  cache: Map<string, string | null>,
  concurrency = 24,
): Promise<void> {
  if (!stagingSubdomain) return;
  const targets = clusters.filter(
    (c) => (c.page_type ?? "blog") === "blog" && !cache.has(c.id),
  );
  if (targets.length === 0) return;

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < targets.length) {
      const i = cursor++;
      const c = targets[i]!;
      try {
        const r = await fetchBlogPlaceholders(stagingSubdomain!, c.id);
        cache.set(c.id, r.body);
      } catch {
        cache.set(c.id, null);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
}

async function recordsForClusterByType(
  cluster: ClusterRow,
  pageType: PageType,
  stagingSubdomain: string | null,
  cache: Map<string, string | null>,
): Promise<ImageRecord[]> {
  if (pageType === "service") return serviceRecords(cluster);
  if (pageType === "category") return categoryRecords(cluster);

  // Blog: page_info.thumbnail is the thumbnail (synthesized record); the
  // inline parser may already supply a real "cover" (Sentinel-style MDX
  // 1st-image convention). When it does, drop the synthetic cover so we
  // don't render two covers per cluster.
  const inline = await inlineRecordsForCluster(cluster, stagingSubdomain, cache);
  const inlineProvidesCover = inline.some((r) => r.asset === "cover");
  const out: ImageRecord[] = [];
  if (!inlineProvidesCover) out.push(coverRecord(cluster));
  out.push(thumbnailRecord(cluster));
  out.push(...inline);
  return out;
}

export async function collectImageRecords(
  clusters: ClusterRow[],
  options: CollectOptions = {},
): Promise<ImageRecord[]> {
  const cache = options.s3Cache ?? new Map<string, string | null>();
  const stagingSubdomain = options.stagingSubdomain ?? null;
  // Per-cluster dispatch uses the cluster's own page_type. Falls back to
  // options.pageType (or "blog") if the cluster row didn't carry one.
  const fallbackPageType: PageType = options.pageType ?? "blog";

  const records: ImageRecord[] = [];
  for (const cluster of clusters) {
    if (options.clusterIds && !options.clusterIds.has(cluster.id)) continue;
    const pt: PageType = cluster.page_type ?? fallbackPageType;
    const rows = await recordsForClusterByType(cluster, pt, stagingSubdomain, cache);
    for (const r of rows) {
      if (options.assetTypes && !options.assetTypes.has(r.asset)) continue;
      if (options.imageIds && !options.imageIds.has(r.imageId)) continue;
      records.push(r);
    }
  }

  // Bulk-resolve real CDN preview URLs from media_registry. Synthetic
  // cover/thumbnail ids (containing "/") are skipped; their previewUrl
  // was already populated from page_info.thumbnail by the resolver.
  const lookupIds = records
    .filter((r) => !r.imageId.includes("/") && !r.previewUrl)
    .map((r) => r.imageId);
  if (lookupIds.length > 0) {
    const urlMap = await lookupImageUrls(lookupIds);
    for (const r of records) {
      const urls = urlMap.get(r.imageId);
      if (urls) {
        // Prefer 720 for the drawer thumbnail; fall back through sizes.
        r.previewUrl = urls["720"] ?? urls["1080"] ?? urls["360"] ?? r.previewUrl;
      }
    }
  }

  // MDX fallback for clusters whose S3 markdown ids didn't resolve in
  // media_registry (e.g., Sentinel placeholders). Group missing
  // records by cluster, scan each cluster's MDX <Image imageId="…"/>
  // tags, and do ONE big media_registry batch across every cluster's
  // MDX UUIDs. Then pair by document-order index per cluster.
  const stillMissing = records.filter((r) => !r.previewUrl && !r.imageId.includes("/"));
  if (stillMissing.length > 0) {
    const byCluster = new Map<string, ImageRecord[]>();
    for (const r of stillMissing) {
      if (!byCluster.has(r.cluster.id)) byCluster.set(r.cluster.id, []);
      byCluster.get(r.cluster.id)!.push(r);
    }

    // Build the per-cluster MDX tag arrays + the global UUID list.
    const mdxByCluster = new Map<string, MdxImageTag[]>();
    const allMdxIds: string[] = [];
    for (const [cid, missing] of byCluster) {
      const cluster = missing[0]!.cluster;
      const md = blogTextMd(cluster.page_info ?? {});
      if (!md) continue;
      const tags = scanMdxImageTags(md);
      if (tags.length === 0) continue;
      mdxByCluster.set(cid, tags);
      for (const t of tags) allMdxIds.push(t.imageId);
    }
    if (allMdxIds.length > 0) {
      const mdxUrls = await lookupImageUrls(allMdxIds);
      for (const [cid, missing] of byCluster) {
        const tags = mdxByCluster.get(cid);
        if (!tags) continue;
        const len = Math.min(missing.length, tags.length);
        for (let i = 0; i < len; i++) {
          const urls = mdxUrls.get(tags[i]!.imageId);
          if (!urls) continue;
          missing[i]!.previewUrl =
            urls["720"] ?? urls["1080"] ?? urls["360"] ?? undefined;
        }
      }
    }
  }

  return records;
}
