import { loadEnv } from "../src/env.js";
import { Pool } from "pg";

loadEnv();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  const r = await pool.query(
    `SELECT id, topic FROM clusters
     WHERE p_id = 'a3af9ee4-e6c1-4003-a444-092618be6867'::uuid
       AND page_type = $1 AND page_status = 'PUBLISHED'
     ORDER BY u_at DESC LIMIT 3`,
    [process.argv[2] ?? "service"],
  );
  for (const row of r.rows) console.log(row.id, "—", row.topic);
}
main()
  .then(() => pool.end())
  .catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
