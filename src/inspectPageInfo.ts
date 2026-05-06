import {
  closePool,
  listPublishedBlogClusters,
  lookupClient,
  type ClusterPageImage,
  type ClusterPageInfo,
  type ClusterRow,
} from "./db.js";

function topLevelKeys(pi: ClusterPageInfo | null): string[] {
  if (!pi) return [];
  return Object.keys(pi).sort();
}

function imageKeys(images: ClusterPageImage[] | undefined): string[] {
  if (!images || images.length === 0) return [];
  const keys = new Set<string>();
  for (const img of images) {
    for (const k of Object.keys(img)) keys.add(k);
  }
  return [...keys].sort();
}

function imageTypeHistogram(images: ClusterPageImage[] | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const img of images ?? []) {
    const t = String(img?.image_type ?? "<missing>");
    counts[t] = (counts[t] ?? 0) + 1;
  }
  return counts;
}

function summariseCluster(cluster: ClusterRow): unknown {
  const pi = cluster.page_info;
  const images = pi?.images ?? [];
  return {
    cluster_id: cluster.id,
    topic: cluster.topic,
    updated_at: cluster.updated_at,
    page_info_keys: topLevelKeys(pi),
    image_count: images.length,
    image_keys: imageKeys(images),
    image_type_histogram: imageTypeHistogram(images),
    cover_candidates: {
      "page_info.cover_image_id": pi?.cover_image_id ?? null,
      "page_info.cover": pi?.cover ?? null,
      "page_info.images[image_type=cover]": images.find((i) => i?.image_type === "cover") ?? null,
    },
    thumbnail_candidates: {
      "page_info.thumbnail_image_id": pi?.thumbnail_image_id ?? null,
      "page_info.thumbnail": pi?.thumbnail ?? null,
      "page_info.images[image_type=thumbnail]":
        images.find((i) => i?.image_type === "thumbnail") ?? null,
    },
    sample_image_object: images[0] ?? null,
    full_page_info: pi,
  };
}

export async function runInspectPageInfo(params: {
  projectId: string;
  limit: number;
}): Promise<void> {
  const clusters = await listPublishedBlogClusters(params.projectId);
  process.stderr.write(
    `inspect-page-info: ${clusters.length} published blog clusters; printing first ${Math.min(params.limit, clusters.length)}\n`,
  );

  const head = clusters.slice(0, params.limit).map(summariseCluster);
  process.stdout.write(JSON.stringify(head, null, 2) + "\n");
}

export async function inspectForSlug(slug: string, limit: number): Promise<void> {
  const project = await lookupClient(slug);
  if (!project) {
    process.stderr.write(`error: no project matched slug '${slug}'\n`);
    await closePool();
    process.exit(2);
  }
  process.stderr.write(
    `inspect-page-info: client='${project.name ?? slug}' project_id=${project.id}\n`,
  );
  await runInspectPageInfo({ projectId: project.id, limit });
}
