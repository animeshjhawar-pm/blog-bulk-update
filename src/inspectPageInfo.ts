import { Pool } from "pg";
import {
  closePool,
  listPublishedClusters,
  lookupProjectById,
  type ClusterRow,
  type ProjectRow,
  type PageType,
} from "./db.js";
import { findClient } from "./clients.js";
import { loadEnv } from "./env.js";
import { fetchBlogPlaceholders, blogPlaceholdersKey } from "./s3.js";

// ── Shape A (S3 markdown): <image_requirement> tag walker ──
const REQ_TAG_GLOBAL =
  /<image_requirement\b([^>]*)>([\s\S]*?)<\/image_requirement>/gi;

interface RequirementTagHit {
  parsedAttrs: Record<string, string>;
  inner: string;
}

function scanImageRequirementTags(s: string): RequirementTagHit[] {
  const out: RequirementTagHit[] = [];
  for (const m of s.matchAll(REQ_TAG_GLOBAL)) {
    const attrs = m[1] ?? "";
    const inner = (m[2] ?? "").trim();
    const parsedAttrs: Record<string, string> = {};
    for (const a of attrs.matchAll(/(\w[\w-]*)\s*=\s*"([^"]*)"/g)) {
      if (a[1]) parsedAttrs[a[1]] = a[2] ?? "";
    }
    out.push({ parsedAttrs, inner });
  }
  return out;
}

// ── Shape B: walk JSON for image-shaped objects ──
interface ShapeBHit {
  path: string;
  image_id: string | null;
  image_type: string | null;
  context: string | null;
  description: string | null;
}

function walkForShapeBImages(node: unknown, path = ""): ShapeBHit[] {
  if (node == null) return [];
  if (Array.isArray(node)) {
    const out: ShapeBHit[] = [];
    node.forEach((v, i) => out.push(...walkForShapeBImages(v, `${path}[${i}]`)));
    return out;
  }
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const looksLikeImage =
      typeof obj.description === "string" &&
      (typeof obj.image_id === "string" ||
        typeof obj.image_type === "string" ||
        typeof obj.context === "string");
    const out: ShapeBHit[] = [];
    if (looksLikeImage) {
      out.push({
        path,
        image_id: typeof obj.image_id === "string" ? obj.image_id : null,
        image_type: typeof obj.image_type === "string" ? obj.image_type : null,
        context: typeof obj.context === "string" ? obj.context : null,
        description: typeof obj.description === "string" ? obj.description : null,
      });
    }
    for (const [k, v] of Object.entries(obj)) {
      out.push(...walkForShapeBImages(v, path ? `${path}.${k}` : k));
    }
    return out;
  }
  return [];
}

// ── Helpers ──
function shorten(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

interface InlineRow {
  index: number;
  image_type: string;
  description_preview: string;
  image_id: string;
  source: "shape-A" | "shape-B" | "synthesised";
}

function buildInlineRowsFromShapeA(
  cluster: ClusterRow,
  hits: RequirementTagHit[],
): InlineRow[] {
  return hits.map((h, i) => {
    const type = (h.parsedAttrs.type ?? "generic").toLowerCase();
    const realId = h.parsedAttrs.id || h.parsedAttrs.image_id;
    return {
      index: i,
      image_type: type,
      description_preview: shorten(h.inner.replace(/\s+/g, " ").trim(), 100),
      image_id: realId || `blog-images/${cluster.id}-${type}-${i}`,
      source: realId ? "shape-A" : "synthesised",
    };
  });
}

function buildInlineRowsFromShapeB(
  cluster: ClusterRow,
  hits: ShapeBHit[],
): InlineRow[] {
  return hits.map((h, i) => {
    const type = (h.image_type ?? h.context ?? "generic").replace(/^#/, "").toLowerCase();
    return {
      index: i,
      image_type: type,
      description_preview: shorten((h.description ?? "").replace(/\s+/g, " ").trim(), 100),
      image_id: h.image_id || `blog-images/${cluster.id}-${type}-${i}`,
      source: h.image_id ? "shape-B" : "synthesised",
    };
  });
}

// ── Aggregate counts (fast pre-flight) ──
async function shapeCountsAndS3Hits(pool: Pool, projectId: string, stagingSubdomain: string | null) {
  const a = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM clusters
     WHERE p_id = $1::uuid AND page_type = 'blog' AND page_status = 'PUBLISHED'
       AND page_info::text ILIKE '%<image_requirement%'`,
    [projectId],
  );
  const b = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM clusters
     WHERE p_id = $1::uuid AND page_type = 'blog' AND page_status = 'PUBLISHED'
       AND jsonb_typeof(page_info->'images') = 'array'`,
    [projectId],
  );
  return {
    shapeA: a.rows[0]?.n ?? 0,
    shapeB: b.rows[0]?.n ?? 0,
    s3PrefixHint: stagingSubdomain
      ? `s3://${process.env.S3_BUCKET ?? "gw-stormbreaker"}/page_data/${stagingSubdomain}/blog/<cluster_id>/output/blog_with_image_placeholders.md`
      : "(no staging_subdomain on project — S3 fetch will be skipped)",
  };
}

async function printClusterReport(cluster: ClusterRow, stagingSubdomain: string | null): Promise<void> {
  const pi = (cluster.page_info ?? {}) as Record<string, unknown>;
  process.stderr.write(`\n=== cluster ${cluster.id} ===\n`);
  process.stderr.write(`  topic:      ${cluster.topic ?? "(none)"}\n`);
  process.stderr.write(`  updated_at: ${cluster.updated_at?.toISOString?.() ?? cluster.updated_at}\n`);
  process.stderr.write(`  page_info top-level keys: ${JSON.stringify(Object.keys(pi).sort())}\n`);

  // Shape A in DB::text
  const piText = JSON.stringify(pi);
  const dbShapeAHits = scanImageRequirementTags(piText);

  // Shape B (JSON walk)
  const shapeBHits = walkForShapeBImages(pi);

  // Shape A in S3 markdown
  let s3Result: Awaited<ReturnType<typeof fetchBlogPlaceholders>> | null = null;
  let s3ShapeAHits: RequirementTagHit[] = [];
  if (stagingSubdomain) {
    try {
      s3Result = await fetchBlogPlaceholders(stagingSubdomain, cluster.id);
      if (s3Result.body) {
        s3ShapeAHits = scanImageRequirementTags(s3Result.body);
      }
    } catch (err) {
      process.stderr.write(`  S3 fetch error: ${(err as Error).message}\n`);
    }
  }

  process.stderr.write(`  Shape A (<image_requirement> in page_info::text): ${dbShapeAHits.length}\n`);
  process.stderr.write(`  Shape B (image-shaped JSON objects in page_info): ${shapeBHits.length}\n`);
  if (s3Result) {
    if (s3Result.notFound) {
      process.stderr.write(`  S3 (${s3Result.key}): NOT FOUND\n`);
    } else {
      process.stderr.write(
        `  S3 (${s3Result.key}): ${s3Result.bytes} bytes, <image_requirement> count = ${s3ShapeAHits.length}\n`,
      );
    }
  }

  // Choose the source: prefer S3 Shape A → DB Shape A → Shape B
  let rows: InlineRow[] = [];
  let source: "S3 shape-A" | "DB shape-A" | "shape-B" | "neither" = "neither";
  if (s3ShapeAHits.length > 0) {
    rows = buildInlineRowsFromShapeA(cluster, s3ShapeAHits);
    source = "S3 shape-A";
  } else if (dbShapeAHits.length > 0) {
    rows = buildInlineRowsFromShapeA(cluster, dbShapeAHits);
    source = "DB shape-A";
  } else if (shapeBHits.length > 0) {
    rows = buildInlineRowsFromShapeB(cluster, shapeBHits);
    source = "shape-B";
  }
  process.stderr.write(`  Detected source: ${source}\n`);

  // Distinct types found
  const types = new Set<string>();
  for (const h of [...s3ShapeAHits, ...dbShapeAHits]) if (h.parsedAttrs.type) types.add(h.parsedAttrs.type);
  for (const h of shapeBHits) if (h.image_type) types.add(h.image_type);
  process.stderr.write(`  Distinct image_types (first 5): ${JSON.stringify([...types].slice(0, 5))}\n`);

  if (rows.length === 0) {
    process.stderr.write(`  ⚠️  No inline images detected by any shape.\n`);
  } else {
    process.stderr.write(
      `  ${"idx".padEnd(4)} ${"type".padEnd(14)} ${"src".padEnd(11)} description (preview)  →  image_id\n`,
    );
    for (const r of rows) {
      process.stderr.write(
        `  ${String(r.index).padEnd(4)} ${r.image_type.padEnd(14)} ${r.source.padEnd(11)} ${shorten(r.description_preview, 50).padEnd(50)}  →  ${r.image_id}\n`,
      );
    }
  }
}

export async function runInspectPageInfo(params: {
  project: ProjectRow;
  limit: number;
  pageType?: PageType;
}): Promise<void> {
  loadEnv();
  const env = process.env;
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const counts = await shapeCountsAndS3Hits(pool, params.project.id, params.project.staging_subdomain);
    process.stderr.write(
      `\n┌── Shape distribution across published blog clusters ──┐\n` +
        `│ clusters_with_image_requirement_tags  (DB Shape A): ${counts.shapeA}\n` +
        `│ clusters_with_top_level_images_array  (Shape B):    ${counts.shapeB}\n` +
        `│ S3 markdown path: ${counts.s3PrefixHint}\n` +
        `└────────────────────────────────────────────────────────┘\n`,
    );
  } finally {
    await pool.end();
  }

  const clusters = await listPublishedClusters(params.project.id, params.pageType ?? "blog");
  process.stderr.write(
    `\ninspect-page-info: ${clusters.length} published blog clusters in DB; printing first ${Math.min(params.limit, clusters.length)}\n`,
  );
  for (const c of clusters.slice(0, params.limit)) {
    await printClusterReport(c, params.project.staging_subdomain);
  }
  process.stderr.write(
    `\n══════════════════════════════════════════════════════════════════\n` +
      `  Confirm with the developer which shape this client uses BEFORE\n` +
      `  any regen-pipeline changes touch the parser.\n` +
      `══════════════════════════════════════════════════════════════════\n`,
  );
}

export async function inspectForSlug(
  slug: string,
  limit: number,
  pageType: PageType = "blog",
): Promise<void> {
  const entry = findClient(slug);
  if (!entry) {
    process.stderr.write(`error: '${slug}' is not in the CLIENTS allow-list\n`);
    await closePool();
    process.exit(2);
  }
  const project = await lookupProjectById(entry.projectId);
  if (!project) {
    process.stderr.write(`error: project ${entry.projectId} not found in DB\n`);
    await closePool();
    process.exit(2);
  }
  process.stderr.write(
    `inspect-page-info: client='${project.name ?? slug}' project_id=${project.id} staging_subdomain=${project.staging_subdomain}\n`,
  );
  await runInspectPageInfo({ project, limit, pageType });
}
