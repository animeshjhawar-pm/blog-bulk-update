import type { ClusterPageImage, ClusterPageInfo, ClusterRow } from "./db.js";

export type AssetType =
  | "cover"
  | "thumbnail"
  | "infographic"
  | "internal"
  | "external"
  | "generic";

export interface ImageRecord {
  cluster: ClusterRow;
  asset: AssetType;
  /**
   * The S3 key (or a synthetic stable identifier for cover/thumbnail rows
   * when the underlying page_info doesn't store one). What the receiving
   * PM uses to perform the S3 replace.
   */
  imageId: string;
  /** The description we feed into the prompt: image.description or cluster.topic. */
  description: string;
  /** "16:9" / "3:2" / "4:3" / "1:1" — already normalised to bare W:H. */
  aspectRatio: string;
  /** Source for traceability — explains where the row came from. */
  source:
    | "page_info.images[]"
    | "cover_image_id"
    | "page_info.cover"
    | "images[image_type=cover]"
    | "thumbnail_image_id"
    | "page_info.thumbnail"
    | "images[image_type=thumbnail]"
    | "synthetic-cover"
    | "synthetic-thumbnail";
}

const DEFAULT_ASPECT: Record<AssetType, string> = {
  cover: "16:9",
  thumbnail: "3:2",
  infographic: "16:9",
  internal: "4:3",
  external: "4:3",
  generic: "4:3",
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

/** Convert "#16:9" / "16:9" / "1:1" → "16:9". Returns null on miss. */
export function parseAspectRatio(context: string | undefined): string | null {
  if (!context) return null;
  const m = /(\d+)\s*:\s*(\d+)/.exec(context);
  if (!m) return null;
  return `${m[1]}:${m[2]}`;
}

function aspectFor(asset: AssetType, contextHint?: string): string {
  return parseAspectRatio(contextHint) ?? DEFAULT_ASPECT[asset];
}

function syntheticId(prefix: "cover-images" | "thumbnail-images", clusterId: string): string {
  return `${prefix}/${clusterId}`;
}

/**
 * Resolve the cover record for a cluster. Tries, in order:
 *   1. page_info.cover_image_id (string)
 *   2. page_info.cover (image-shaped object or string)
 *   3. images[image_type === "cover"]
 *   4. fall back to a synthetic record keyed off cluster.id
 *
 * The receiving PM will key on imageId for the S3 replace; if the cluster
 * doesn't store a cover in page_info today, the synthetic key
 * `cover-images/<cluster_id>` lets them know there's nothing to overwrite
 * — a fresh cover needs to be inserted at a new S3 key.
 */
function resolveCover(cluster: ClusterRow): ImageRecord {
  const pi = cluster.page_info ?? {};
  const description = (cluster.topic ?? pi.title ?? "").trim();

  if (typeof pi.cover_image_id === "string" && pi.cover_image_id.length > 0) {
    return {
      cluster,
      asset: "cover",
      imageId: pi.cover_image_id,
      description,
      aspectRatio: aspectFor("cover"),
      source: "cover_image_id",
    };
  }

  if (pi.cover && typeof pi.cover === "object") {
    const obj = pi.cover as ClusterPageImage;
    if (typeof obj.image_id === "string") {
      return {
        cluster,
        asset: "cover",
        imageId: obj.image_id,
        description: (obj.description ?? description).trim(),
        aspectRatio: aspectFor("cover", obj.context),
        source: "page_info.cover",
      };
    }
  }
  if (typeof pi.cover === "string" && pi.cover.length > 0) {
    return {
      cluster,
      asset: "cover",
      imageId: pi.cover,
      description,
      aspectRatio: aspectFor("cover"),
      source: "page_info.cover",
    };
  }

  const inline = (pi.images ?? []).find((i) => normalizeImageType(i?.image_type) === "cover");
  if (inline && typeof inline.image_id === "string") {
    return {
      cluster,
      asset: "cover",
      imageId: inline.image_id,
      description: (inline.description ?? description).trim(),
      aspectRatio: aspectFor("cover", inline.context),
      source: "images[image_type=cover]",
    };
  }

  return {
    cluster,
    asset: "cover",
    imageId: syntheticId("cover-images", cluster.id),
    description,
    aspectRatio: aspectFor("cover"),
    source: "synthetic-cover",
  };
}

function resolveThumbnail(cluster: ClusterRow): ImageRecord {
  const pi = cluster.page_info ?? {};
  const description = (cluster.topic ?? pi.title ?? "").trim();

  if (typeof pi.thumbnail_image_id === "string" && pi.thumbnail_image_id.length > 0) {
    return {
      cluster,
      asset: "thumbnail",
      imageId: pi.thumbnail_image_id,
      description,
      aspectRatio: aspectFor("thumbnail"),
      source: "thumbnail_image_id",
    };
  }

  if (pi.thumbnail && typeof pi.thumbnail === "object") {
    const obj = pi.thumbnail as ClusterPageImage;
    if (typeof obj.image_id === "string") {
      return {
        cluster,
        asset: "thumbnail",
        imageId: obj.image_id,
        description: (obj.description ?? description).trim(),
        aspectRatio: aspectFor("thumbnail", obj.context),
        source: "page_info.thumbnail",
      };
    }
  }
  if (typeof pi.thumbnail === "string" && pi.thumbnail.length > 0) {
    return {
      cluster,
      asset: "thumbnail",
      imageId: pi.thumbnail,
      description,
      aspectRatio: aspectFor("thumbnail"),
      source: "page_info.thumbnail",
    };
  }

  const inline = (pi.images ?? []).find((i) => normalizeImageType(i?.image_type) === "thumbnail");
  if (inline && typeof inline.image_id === "string") {
    return {
      cluster,
      asset: "thumbnail",
      imageId: inline.image_id,
      description: (inline.description ?? description).trim(),
      aspectRatio: aspectFor("thumbnail", inline.context),
      source: "images[image_type=thumbnail]",
    };
  }

  return {
    cluster,
    asset: "thumbnail",
    imageId: syntheticId("thumbnail-images", cluster.id),
    description,
    aspectRatio: aspectFor("thumbnail"),
    source: "synthetic-thumbnail",
  };
}

/**
 * Walk page_info.images[] and emit a record per generated-images entry,
 * skipping anything already classified as cover/thumbnail (those rows
 * come from resolveCover / resolveThumbnail above).
 */
function inlineImageRecords(cluster: ClusterRow): ImageRecord[] {
  const pi = cluster.page_info;
  const images = pi?.images ?? [];
  const out: ImageRecord[] = [];
  for (const img of images) {
    if (typeof img?.image_id !== "string") continue;
    if (!img.image_id.startsWith("generated-images/")) continue;
    const asset = normalizeImageType(img.image_type);
    if (asset === "cover" || asset === "thumbnail") continue;
    out.push({
      cluster,
      asset,
      imageId: img.image_id,
      description: (img.description ?? "").trim(),
      aspectRatio: aspectFor(asset, img.context),
      source: "page_info.images[]",
    });
  }
  return out;
}

export interface CollectOptions {
  /** When set, only clusters whose id is in this set are walked. */
  clusterIds?: Set<string>;
  /** When set, only records whose asset matches are emitted. */
  assetTypes?: Set<AssetType>;
}

export function collectImageRecords(
  clusters: ClusterRow[],
  options: CollectOptions = {},
): ImageRecord[] {
  const records: ImageRecord[] = [];
  for (const cluster of clusters) {
    if (options.clusterIds && !options.clusterIds.has(cluster.id)) continue;

    const cover = resolveCover(cluster);
    const thumb = resolveThumbnail(cluster);
    const inline = inlineImageRecords(cluster);

    for (const r of [cover, thumb, ...inline]) {
      if (options.assetTypes && !options.assetTypes.has(r.asset)) continue;
      records.push(r);
    }
  }
  return records;
}
