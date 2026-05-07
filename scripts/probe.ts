import { loadEnv } from "../src/env.js";
import { listPublishedBlogClusters, lookupProjectById, closePool } from "../src/db.js";
import { collectImageRecords } from "../src/pageInfo.js";
import { findClient } from "../src/clients.js";

loadEnv();

async function main() {
  const entry = findClient("sentinel-asset-management");
  if (!entry) throw new Error("missing allow-list entry");
  const project = await lookupProjectById(entry.projectId);
  if (!project) throw new Error("project not found");
  console.log("project:", project.name, project.staging_subdomain);

  const clusters = await listPublishedBlogClusters(entry.projectId);
  console.log("clusters:", clusters.length);

  const s3Cache = new Map<string, string | null>();
  const t0 = Date.now();
  const all = await collectImageRecords(clusters, {
    stagingSubdomain: project.staging_subdomain,
    s3Cache,
  });
  const ms = Date.now() - t0;

  const byAsset: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  for (const r of all) {
    byAsset[r.asset] = (byAsset[r.asset] ?? 0) + 1;
    bySource[r.source] = (bySource[r.source] ?? 0) + 1;
  }
  console.log(`\nrecords collected: ${all.length}`);
  console.log("by asset:", byAsset);
  console.log("by source:", bySource);
  console.log(`time: ${ms} ms (single-threaded; web UI parallelises)`);

  const sample = all.find((r) => r.source === "s3-shape-A");
  if (sample) {
    console.log("\nsample S3-derived record:");
    console.log("  cluster:", sample.cluster.id);
    console.log("  asset:  ", sample.asset);
    console.log("  imageId:", sample.imageId);
    console.log("  aspect: ", sample.aspectRatio);
    console.log("  desc:   ", sample.description.slice(0, 140));
  }
}

main()
  .then(() => closePool())
  .catch(async (e) => {
    console.error("FAIL:", e?.message ?? e);
    await closePool();
    process.exit(1);
  });
