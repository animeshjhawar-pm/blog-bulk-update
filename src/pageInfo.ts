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
  | "page_info.thumbnail"
  | "synthetic-cover"
  | "synthetic-thumbnail"
  | "page_info.images[0]"
  | "page_info.fold_data.service_steps.images[0]"
  | "page_info.fold_data.service_description.images[0]"
  | "page_info.fold_data.industries.items[]"
  | "page_info.blog_text.md<Image>[0]";

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

/**
 * Extract the underlying image-hash id from a thumbnail/CDN URL such as
 *   …/blog-images/<cluster_id>/<timestamp>_<hex32>/1080.webp
 *   …/blog-images/<cluster_id>/<timestamp>_<hex32>.webp
 * The hash segment is what `apply` needs to write against in S3 — it is
 * the same shape that media_registry stores under
 * `blog-images/<cluster_id>/<hash>` so lookupImageUrls also resolves it
 * back to the existing CDN urls.
 */
function imageIdFromThumbnailUrl(url: string | undefined): string | null {
  if (!url) return null;
  // Strip any query/fragment, then take the last 2 path segments.
  let clean = url.split("#")[0];
  clean = clean!.split("?")[0]!;
  const parts = clean.split("/").filter(Boolean);
  // Walk backward looking for a `<digits>_<hex>` segment.
  const idRe = /^\d+_[0-9a-f]{16,}$/i;
  for (let i = parts.length - 1; i >= 0; i--) {
    const seg = parts[i]!;
    const stripped = seg.replace(/\.(webp|png|jpe?g)$/i, "");
    if (idRe.test(stripped)) return stripped;
  }
  return null;
}

function coverRecord(cluster: ClusterRow): ImageRecord {
  const pi = cluster.page_info ?? {};
  const description = descriptionFor(cluster);
  const aspect = DEFAULT_ASPECT.cover;

  // Per spec: the cover image's UUID is the 1st <Image imageId="…"/>
  // tag in page_info.blog_text.md. Use that UUID as the canonical
  // imageId so (a) media_registry resolves a real previewUrl and (b)
  // the apply step writes against the actual S3 key.
  const md = blogTextMd(pi);
  if (md) {
    const tags = scanMdxImageTags(md);
    if (tags[0]?.imageId) {
      return {
        cluster,
        asset: "cover",
        imageId: tags[0].imageId,
        description,
        aspectRatio: aspect,
        source: "page_info.blog_text.md<Image>[0]",
      };
    }
  }

  if (typeof pi.cover_image_id === "string" && (pi.cover_image_id as string).length > 0) {
    return { cluster, asset: "cover", imageId: pi.cover_image_id as string, description, aspectRatio: aspect, source: "page_info.cover_image_id" };
  }
  const coverObj = pi.cover;
  if (coverObj && typeof coverObj === "object") {
    const inner = (coverObj as { image_id?: unknown }).image_id;
    if (typeof inner === "string" && inner.length > 0) {
      return { cluster, asset: "cover", imageId: inner, description, aspectRatio: aspect, source: "page_info.cover.image_id" };
    }
  }
  // Last-resort synthetic cover; previewUrl defaults to thumbnail URL
  // so the operator at least sees the page hero.
  const previewUrl = thumbnailUrlOf(pi);
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
  // Best-effort: parse the hash id out of the thumbnail URL itself —
  // every featured client's templates encode the real S3 image id in
  // the path, e.g. `…/blog-images/<cluster>/<timestamp>_<hex>/1080.webp`.
  const fromUrl = imageIdFromThumbnailUrl(previewUrl);
  if (fromUrl) {
    return { cluster, asset: "thumbnail", imageId: fromUrl, description, aspectRatio: aspect, source: "page_info.thumbnail", previewUrl };
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

// MDX <Image .../> tag scanner — robust to attribute order. The
// previous regex assumed `alt` came after `imageId`, which is fine
// for some templates but breaks for any tag that lists attributes
// in a different order (alt-first, custom attributes between them,
// etc.). We now extract attributes independently from each tag's
// attribute span: first pluck the whole tag, then pull imageId and
// alt out by name regardless of where they sit.
const MDX_IMAGE_TAG_RE = /<Image\b([^>]*)\/>/gi;
const MDX_ATTR_IMAGE_ID = /\bimageId\s*=\s*"([^"]+)"/i;
const MDX_ATTR_ALT      = /\balt\s*=\s*"([^"]*)"/i;

interface MdxImageTag {
  imageId: string;
  alt: string;
}

function scanMdxImageTags(md: string): MdxImageTag[] {
  const out: MdxImageTag[] = [];
  for (const m of md.matchAll(MDX_IMAGE_TAG_RE)) {
    const attrs = m[1] ?? "";
    const imageId = (MDX_ATTR_IMAGE_ID.exec(attrs)?.[1] ?? "").trim();
    if (!imageId) continue;
    const alt = (MDX_ATTR_ALT.exec(attrs)?.[1] ?? "").trim();
    out.push({ imageId, alt });
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
 * Convert MDX <Image> tags to ImageRecords. Per the user's spec for
 * Sentinel-style blogs, the 1st tag is consumed by coverRecord, so
 * here we only emit the 2nd-onwards as inline infographics.
 * page_info.thumbnail is handled by thumbnailRecord.
 */
function mdxToRecords(cluster: ClusterRow, tags: MdxImageTag[]): ImageRecord[] {
  return tags.slice(1).map((t) => ({
    cluster,
    asset: "infographic" as AssetType,
    imageId: t.imageId,
    description: t.alt,
    aspectRatio: DEFAULT_ASPECT.infographic,
    source: "page_info.blog_text.md<Image>[0]" as ImageSource,
  }));
}

async function inlineRecordsForCluster(
  cluster: ClusterRow,
  stagingSubdomain: string | null,
  cache: Map<string, string | null>,
): Promise<ImageRecord[]> {
  // 1. MDX (page_info.blog_text.md <Image imageId="UUID"/>) — Sentinel /
  //    SpecGas-style blogs. Promoted from "fallback shape" to "primary"
  //    because each MDX tag's UUID maps DIRECTLY to media_registry,
  //    yielding the published image URL without any guesswork. Previous
  //    behaviour preferred S3-markdown placeholders and used MDX only
  //    as a fallback for unresolved hashes — the trouble being that
  //    the S3 markdown is a pre-publish BLUEPRINT and the rendering
  //    pipeline doesn't preserve placeholder-index ↔ MDX-tag-index.
  //    Result: the "old" image in Compare could be a completely
  //    different illustration from the description shown to the
  //    operator (real example: SpecGas cluster b39b12ce had the
  //    S3 markdown describing an "intact vs torn PTFE membrane"
  //    comparison while MDX[3] at the paired position was "torn
  //    PTFE membrane only" — two different images).
  //
  //    MDX-first means the description is the alt text (terser than
  //    the S3 markdown) but it's the alt of the IMAGE THAT'S ACTUALLY
  //    ON THE PUBLISHED PAGE. Drawer previews + Compare-modal "old"
  //    pane + Apply-to-S3 target all line up.
  const md = blogTextMd(cluster.page_info ?? {});
  if (md) {
    const mdxTags = scanMdxImageTags(md);
    if (mdxTags.length > 0) return mdxToRecords(cluster, mdxTags);
  }

  // 2. S3 markdown <image_requirement> placeholders — for clusters
  //    that don't ship blog_text.md (legacy / non-Sentinel templates).
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

  // 3. DB Shape A — <image_requirement> tags embedded inside the
  //    page_info JSONB (some templates inline the markdown).
  const piText = JSON.stringify(cluster.page_info ?? {});
  const dbTags = scanRequirementTags(piText);
  if (dbTags.length > 0) return shapeAToRecords(cluster, dbTags, "db-shape-A");

  // 4. Shape B — tree walk for image-shaped objects (very legacy).
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

  // Body: lives at one of two paths depending on the page template —
  //   fold_data.service_steps.images[0]        (ACH, Inzure)
  //   fold_data.service_description.images[0]  (Sentinel, SpecGas, Trussed)
  // Probe both, in order, and take the first hit.
  const bodySources: Array<{ key: string; src: ImageSource }> = [
    { key: "service_steps", src: "page_info.fold_data.service_steps.images[0]" },
    { key: "service_description", src: "page_info.fold_data.service_description.images[0]" },
  ];
  const fold = pi.fold_data;
  if (fold && typeof fold === "object") {
    for (const { key, src } of bodySources) {
      const node = (fold as Record<string, unknown>)[key];
      if (!node || typeof node !== "object") continue;
      const imgs = (node as { images?: unknown }).images;
      if (!Array.isArray(imgs) || !imgs[0]) continue;
      const obj = imageFromObject(imgs[0]);
      if (!obj) continue;
      const r = recordFromImageObject({
        cluster,
        asset: "service_body",
        obj,
        source: src,
        fallbackDescription: cluster.topic ?? "",
      });
      if (r) { out.push(r); break; }
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

  // Blog: cover comes from coverRecord (which prefers the 1st MDX
  // <Image> UUID, falling back to synthetic). thumbnail is always
  // synthesised from page_info.thumbnail. inline images come from
  // S3 markdown / DB Shape A / MDX (2nd+) / Shape B in that order.
  const inline = await inlineRecordsForCluster(cluster, stagingSubdomain, cache);
  return [coverRecord(cluster), thumbnailRecord(cluster), ...inline];
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

  // (Previously this is where an MDX-pair fallback ran for clusters
  // whose S3-markdown hash IDs didn't resolve in media_registry. It
  // paired `missing[i]` ↔ `tags[i + cover-offset]` by document order
  // — which turned out to be unreliable: the S3 markdown is a
  // pre-publish blueprint and the rendering pipeline doesn't
  // preserve placeholder-index ↔ MDX-tag-index. Result was that
  // the "old" image in Compare could show a different illustration
  // from the one matching the description. The fallback is now gone
  // — `inlineRecordsForCluster` prefers MDX directly when
  // blog_text.md is present, so each record's imageId is the MDX
  // UUID and its previewUrl resolves via the first batch above with
  // no guesswork.)

  return records;
}
