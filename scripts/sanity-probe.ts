import { loadEnv } from "../src/env.js";
import { Pool } from "pg";
import { collectImageRecords, prefetchBlogMarkdowns } from "../src/pageInfo.js";
import type { ClusterRow } from "../src/db.js";

loadEnv();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL!,
  ssl: { rejectUnauthorized: false }, max: 2,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main() {
  // Pick one cluster per page_type for SpecGas + one for Sentinel.
  const tests = [
    { project_id: "c56bcf16-262c-41e4-8a34-4f14f7d4c579", staging: "specgasinc-tiygg8", pt: "blog" },
    { project_id: "c56bcf16-262c-41e4-8a34-4f14f7d4c579", staging: "specgasinc-tiygg8", pt: "service" },
    { project_id: "c56bcf16-262c-41e4-8a34-4f14f7d4c579", staging: "specgasinc-tiygg8", pt: "category" },
    { project_id: "a3af9ee4-e6c1-4003-a444-092618be6867", staging: "sentinelassetmanagementllc-lo1ayr", pt: "blog" },
  ];

  for (const t of tests) {
    const r = await pool.query<ClusterRow>(
      `SELECT id, topic, page_info, u_at AS updated_at, page_type, slug
       FROM clusters
       WHERE p_id = $1::uuid AND page_type = $2 AND page_status = 'PUBLISHED'
       ORDER BY u_at DESC LIMIT 1`,
      [t.project_id, t.pt],
    );
    if (!r.rows[0]) { console.log(`\n=== ${t.staging} ${t.pt}: NO PUBLISHED CLUSTER ===`); continue; }
    const cluster = r.rows[0];
    console.log(`\n=== ${t.staging}/${t.pt}/${cluster.topic ?? "(no topic)"} ===`);
    console.log(`    cluster: ${cluster.id}`);

    const cache = new Map<string, string | null>();
    await prefetchBlogMarkdowns([cluster], t.staging, cache);
    const records = await collectImageRecords([cluster], { stagingSubdomain: t.staging, s3Cache: cache });

    for (const rec of records) {
      const id = rec.imageId;
      const isUuid = UUID_RE.test(id);
      console.log(`  • [${rec.asset}] image_id = ${id}`);
      console.log(`        previewUrl: ${rec.previewUrl ?? "(none)"}`);

      // Look up in media_registry. UUID → by id, else → by key suffix.
      let row;
      if (isUuid) {
        const q = await pool.query<{ id:string; key:string; urls:any; pid:string }>(
          `SELECT id::text, key, urls, p_id::text AS pid FROM media_registry WHERE id = $1::uuid`,
          [id],
        );
        row = q.rows[0];
      } else {
        const q = await pool.query<{ id:string; key:string; urls:any; pid:string }>(
          `SELECT id::text, key, urls, p_id::text AS pid FROM media_registry WHERE key LIKE $1`,
          [`%/${id}`],
        );
        row = q.rows[0];
      }
      if (!row) { console.log(`        ⛔ media_registry: NO ROW`); continue; }

      const u1080 = row.urls?.["1080"] ?? row.urls?.["720"] ?? "(none)";
      // Verify the previewUrl we'd render matches the row's URLs
      const matchesPreview =
        rec.previewUrl && (rec.previewUrl === row.urls?.["720"] || rec.previewUrl === row.urls?.["1080"] || rec.previewUrl === row.urls?.["360"]);
      console.log(`        ✓  media_registry row: ${row.id}`);
      console.log(`           key: ${row.key}`);
      console.log(`           1080 url: ${u1080}`);
      console.log(`           preview matches row.urls.*: ${matchesPreview ? "YES" : "NO ⚠"}`);
    }
  }
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
