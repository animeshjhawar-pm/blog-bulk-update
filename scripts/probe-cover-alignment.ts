import { loadEnv } from "../src/env.js";
import { Pool } from "pg";
loadEnv();
const pool = new Pool({ connectionString: process.env.DATABASE_URL!, ssl: { rejectUnauthorized: false }, max: 2 });

async function main() {
  // Five clusters across the featured allow-list — verify whether
  // the cover image's MDX <Image> is ALWAYS at position [0] (what
  // our coverRecord currently assumes) or sometimes elsewhere.
  const slugs = ["sentinelassetmanagementllc-lo1ayr","specgasinc-tiygg8","trussed-l05mo8","achengineering-6iwgqb","inzure-hqx5wx"];

  for (const sub of slugs) {
    const proj = await pool.query<{id:string,name:string}>(`SELECT id, name FROM projects WHERE staging_subdomain=$1`, [sub]);
    if (!proj.rows[0]) continue;
    const r = await pool.query<{id:string,topic:string,page_info:any}>(
      `SELECT id, topic, page_info FROM clusters WHERE p_id=$1::uuid AND page_status='PUBLISHED' AND page_type='blog' ORDER BY u_at DESC LIMIT 1`,
      [proj.rows[0].id]);
    if (!r.rows[0]) continue;
    const c = r.rows[0];
    console.log(`\n=== ${proj.rows[0].name} · cluster ${c.id.slice(0,8)} ===`);
    console.log(`    topic: "${c.topic}"`);
    const pi = c.page_info ?? {};
    const md = typeof pi.blog_text === "string" ? pi.blog_text : (pi.blog_text?.md ?? "");
    if (!md) { console.log("    no blog_text.md"); continue; }
    const tags = [...md.matchAll(/<Image\b([^>]*)\/>/g)];
    console.log(`    MDX <Image/> count: ${tags.length}`);
    tags.forEach((m, i) => {
      const attrs = m[1] ?? "";
      const id = /\bimageId="([^"]+)"/.exec(attrs)?.[1] ?? "(none)";
      const alt = /\balt="([^"]+)"/.exec(attrs)?.[1] ?? "(none)";
      // Is the alt text the cluster topic? → that's the cover
      const isLikelyCover = alt.trim() === (c.topic ?? "").trim();
      console.log(`    [${i}] ${isLikelyCover ? "👈 likely COVER" : ""}`);
      console.log(`        imageId: ${id.slice(0,40)}`);
      console.log(`        alt:     ${alt.slice(0,80)}${alt.length>80?"…":""}`);
    });
    // Also show where the matched <Image> sits in the markdown — char offset.
    const indexes = [...md.matchAll(/<Image\b/g)].map(m => m.index);
    console.log(`    char offsets: ${indexes.join(", ")}`);
    console.log(`    md length: ${md.length}`);
  }
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
