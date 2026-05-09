import { loadEnv } from "../src/env.js";
import { Pool } from "pg";

loadEnv();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  const queries = [
    { label: "specgas",         pat: ["%specgas%", "%spec gas%"] },
    { label: "trussed AI",      pat: ["%trussed%"] },
    { label: "ACH Engineering", pat: ["%ach engineering%", "%ach %"] },
    { label: "Inzure",          pat: ["%inzure%"] },
    { label: "hydrogen-cyanide-cost (verify)", pat: ["%hydrogen cyanide%", "%hydrogen-cyanide%"] },
  ];

  for (const { label, pat } of queries) {
    console.log(`\n=== ${label} ===`);
    const conditions = pat.map((_, i) => `(name ILIKE $${i + 1} OR url ILIKE $${i + 1} OR staging_subdomain ILIKE $${i + 1})`).join(" OR ");
    const r = await pool.query<{ id: string; name: string; url: string | null; staging_subdomain: string | null }>(
      `SELECT id, name, url, staging_subdomain FROM projects WHERE ${conditions} ORDER BY u_at DESC NULLS LAST LIMIT 8`,
      pat,
    );
    if (r.rows.length === 0) console.log("  (no matches)");
    for (const row of r.rows) {
      console.log(`  ${row.id}  ${row.name}  ${row.url ?? ""}  staging=${row.staging_subdomain ?? ""}`);
    }
  }

  // Verify the explicitly given hydrogen-cyanide-cost project_id
  const hcc = await pool.query(`SELECT id, name, url, staging_subdomain FROM projects WHERE id = 'c56bcf16-262c-41e4-8a34-4f14f7d4c579'::uuid`);
  console.log("\n=== hydrogen-cyanide-cost (by given UUID) ===");
  for (const row of hcc.rows) console.log(`  ${row.id}  ${row.name}  ${row.url ?? ""}  staging=${row.staging_subdomain ?? ""}`);
}

main().then(() => pool.end()).catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
