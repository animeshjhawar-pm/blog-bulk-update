import { loadEnv } from "../src/env.js";
import { Pool } from "pg";

loadEnv();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  const cols = await pool.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_name = 'media_registry' ORDER BY ordinal_position`,
  );
  console.log("media_registry columns:");
  for (const r of cols.rows) console.log("  -", r.column_name, "(" + r.data_type + ")");

  // Test lookup with the known service-page UUID and a category UUID.
  for (const id of [
    "12e80b1a-9630-41ee-b381-ed554f30c131", // UnleashX service H1
    "8ac6fe7c-aa3c-450b-8f27-33f50c0eaab5", // The Mesh Nest category industry
  ]) {
    const r = await pool.query(`SELECT * FROM media_registry WHERE id = $1::uuid LIMIT 1`, [id]);
    console.log(`\nlookup ${id}:`);
    if (r.rows.length === 0) {
      // try id::text or other column names
      const fallback = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'media_registry'`,
      );
      console.log("  no hit by id; columns are:", fallback.rows.map((x) => x.column_name));
    } else {
      for (const row of r.rows) console.log("  ", JSON.stringify(row, null, 2).slice(0, 500));
    }
  }
}
main().then(() => pool.end()).catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
