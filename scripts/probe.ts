import { loadEnv } from "../src/env.js";
import { listPublishedClusters, lookupImageUrls, closePool } from "../src/db.js";
import { collectImageRecords } from "../src/pageInfo.js";

loadEnv();

async function audit(slug: string, projectId: string) {
  console.log(`\n=== ${slug} (${projectId}) ===`);

  for (const pageType of ["blog", "service", "category"] as const) {
    const clusters = await listPublishedClusters(projectId, pageType);
    if (clusters.length === 0) {
      console.log(`  ${pageType}: 0 clusters`);
      continue;
    }
    const records = await collectImageRecords(clusters, { pageType });
    const byAsset: Record<string, number> = {};
    for (const r of records) byAsset[r.asset] = (byAsset[r.asset] ?? 0) + 1;
    const withPreview = records.filter((r) => r.previewUrl).length;
    const expected = pageType === "blog"
      ? `cover ${clusters.length} + thumbnail ${clusters.length} + N inline (variable)`
      : pageType === "service"
        ? `up to ${clusters.length * 2} (H1 + body per cluster)`
        : `variable (one per industry item)`;
    console.log(`  ${pageType}: ${clusters.length} clusters → ${records.length} image records (expected: ${expected})`);
    console.log(`    by asset:`, byAsset);
    console.log(`    with real previewUrl: ${withPreview}/${records.length}`);
    // Show first cluster's records for sanity
    if (records.length > 0) {
      const firstCluster = records[0]!.cluster.id;
      const sample = records.filter((r) => r.cluster.id === firstCluster);
      console.log(`    cluster ${firstCluster}: ${sample.length} records`);
      for (const r of sample) {
        console.log(`      - ${r.asset} ${r.imageId} preview=${r.previewUrl ? "YES" : "no"}`);
      }
    }
  }
}

async function main() {
  await audit("specgas", "c56bcf16-262c-41e4-8a34-4f14f7d4c579");
}

main().then(() => closePool()).catch(async (e) => { console.error(e); await closePool(); process.exit(1); });
