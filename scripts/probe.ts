import { loadEnv } from "../src/env.js";
import { Pool } from "pg";

loadEnv();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  const placeholderIds = [
    "1775738421995775_31f74865087649f8af51d8b",
    "1775738421995823_b7e7d6c5fa7f4142859246d",
    "1775738421995841_41b59ad41966486ba5e13b3",
    "1775738421995855_0ba973b6a04347bfb5c06bc",
  ];
  for (const id of placeholderIds) {
    const exact = await pool.query(
      `SELECT key FROM media_registry WHERE key = $1`,
      [`generated-images/${id}`],
    );
    const suffix = await pool.query(
      `SELECT key FROM media_registry WHERE key LIKE $1 LIMIT 5`,
      [`%/${id}`],
    );
    const partial = await pool.query(
      `SELECT key FROM media_registry WHERE key LIKE $1 LIMIT 5`,
      [`%${id.slice(0, 25)}%`],
    );
    console.log(`\nID ${id}:`);
    console.log(`  exact "generated-images/${id}":`, exact.rows.length, "row(s)");
    console.log(`  suffix "%/<id>":`, suffix.rows.map((r) => r.key).slice(0, 3));
    console.log(`  partial start match (first 25 chars):`, partial.rows.map((r) => r.key).slice(0, 3));
  }

  // Sentinel cluster 4febee1f's S3 markdown — what tags actually exist?
  const r = await pool.query(`SELECT page_info FROM clusters WHERE id = $1`, ["4febee1f-ce02-4270-ad8b-c9f441ca29fd"]);
  const md = r.rows[0]?.page_info?.blog_text?.md ?? "";
  const mdxIds: string[] = [];
  for (const m of String(md).matchAll(/<Image\b[^/]*imageId\s*=\s*"([^"]+)"/g)) if (m[1]) mdxIds.push(m[1]);
  console.log("\nMDX UUIDs in cluster 4febee1f:", mdxIds);
}

main().then(() => pool.end()).catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
