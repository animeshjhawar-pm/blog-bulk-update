import { Pool } from "pg";
import { loadEnv } from "./env.js";

let pool: Pool | null = null;

function getPool(): Pool {
  if (pool) return pool;
  const env = loadEnv();
  pool = new Pool({
    connectionString: env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 4,
  });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export interface ProjectRow {
  id: string;
  name: string | null;
  url: string | null;
  /** Used as the client-prefix in S3 paths: `page_data/<staging_subdomain>/blog/...` */
  staging_subdomain: string | null;
  additional_info: unknown;
  company_info: unknown;
  design_tokens: unknown;
  logo_urls: unknown;
}

/**
 * Look up a project by its UUID. The `projects` table has no `slug`
 * column — slugs are only in our local allow-list, which carries
 * `projectId` directly.
 */
export async function lookupProjectById(projectId: string): Promise<ProjectRow | null> {
  const sql = `
    SELECT id, name, url, staging_subdomain,
           additional_info, company_info, design_tokens, logo_urls
    FROM projects
    WHERE id = $1::uuid
    LIMIT 1
  `;
  const res = await getPool().query<ProjectRow>(sql, [projectId]);
  return res.rows[0] ?? null;
}

/**
 * page_info is JSONB and per-project freeform — every key is optional,
 * the only thing we actually count on is `page_info` being an object.
 */
export type ClusterPageInfo = Record<string, unknown>;

export interface ClusterRow {
  id: string;
  topic: string | null;
  page_info: ClusterPageInfo | null;
  updated_at: Date;
}

export type PageType = "blog" | "service" | "category";

/**
 * Real schema: clusters.p_id (not project_id), clusters.page_status='PUBLISHED'
 * (uppercase), clusters.u_at (not updated_at). Page-status filter is enforced
 * for every page_type — we never surface unpublished clusters in the UI.
 */
export async function listPublishedClusters(
  projectId: string,
  pageType: PageType = "blog",
): Promise<ClusterRow[]> {
  const sql = `
    SELECT id, topic, page_info, u_at AS updated_at
    FROM clusters
    WHERE p_id = $1::uuid
      AND page_type = $2
      AND page_status = 'PUBLISHED'
    ORDER BY u_at DESC
  `;
  const res = await getPool().query<ClusterRow>(sql, [projectId, pageType]);
  return res.rows;
}

/** Backwards-compat alias — existing call sites that only deal with blogs. */
export async function listPublishedBlogClusters(projectId: string): Promise<ClusterRow[]> {
  return listPublishedClusters(projectId, "blog");
}

// ────────────────────────────────────────────────────────────────────────
// media_registry — UUID → S3 key + CDN URLs
// ────────────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MediaUrls {
  "360"?: string;
  "720"?: string;
  "1080"?: string;
  [size: string]: string | undefined;
}

/**
 * Bulk-lookup CDN URLs for the supplied image_ids. Two formats supported:
 *  - UUID image_ids (service / category) → media_registry.id
 *  - <timestamp>_<hex> image_ids (blog inline) → media_registry.key matches
 *    `generated-images/<id>` (the key is prefixed in the DB).
 *
 * Returns a Map keyed by the requested image_id (verbatim) → its `urls`
 * JSONB. Missing rows are simply absent from the map; callers fall back
 * to a placeholder.
 */
export async function lookupImageUrls(imageIds: string[]): Promise<Map<string, MediaUrls>> {
  if (imageIds.length === 0) return new Map();
  const uuids: string[] = [];
  const keys: string[] = [];
  for (const id of imageIds) {
    if (UUID_RE.test(id)) uuids.push(id);
    else keys.push(`generated-images/${id}`);
  }
  const out = new Map<string, MediaUrls>();
  const pool = getPool();

  if (uuids.length > 0) {
    const r = await pool.query<{ id: string; urls: MediaUrls }>(
      `SELECT id::text AS id, urls FROM media_registry WHERE id = ANY($1::uuid[])`,
      [uuids],
    );
    for (const row of r.rows) out.set(row.id, row.urls ?? {});
  }
  if (keys.length > 0) {
    const r = await pool.query<{ key: string; urls: MediaUrls }>(
      `SELECT key, urls FROM media_registry WHERE key = ANY($1::text[])`,
      [keys],
    );
    for (const row of r.rows) {
      // Map back to the original image_id (strip "generated-images/" prefix).
      const orig = row.key.replace(/^generated-images\//, "");
      out.set(orig, row.urls ?? {});
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────
// Project search (across the entire DB, not just the allow-list)
// ────────────────────────────────────────────────────────────────────────

export interface ProjectSearchHit {
  id: string;
  name: string | null;
  url: string | null;
  staging_subdomain: string | null;
}

export async function searchProjects(query: string, limit = 20): Promise<ProjectSearchHit[]> {
  const q = (query ?? "").trim();
  if (!q) return [];
  const sql = `
    SELECT id, name, url, staging_subdomain
    FROM projects
    WHERE name ILIKE $1 OR url ILIKE $1 OR staging_subdomain ILIKE $1 OR id::text = $2
    ORDER BY (CASE WHEN name ILIKE $1 THEN 0 ELSE 1 END), u_at DESC NULLS LAST
    LIMIT $3
  `;
  const res = await getPool().query<ProjectSearchHit>(sql, [`%${q}%`, q, limit]);
  return res.rows;
}

/** How many published clusters of each page_type does this project have? */
export async function publishedClusterCountsByPageType(
  projectId: string,
): Promise<Record<PageType, number>> {
  const sql = `
    SELECT page_type, count(*)::int AS n
    FROM clusters
    WHERE p_id = $1::uuid
      AND page_status = 'PUBLISHED'
      AND page_type IN ('blog', 'service', 'category')
    GROUP BY 1
  `;
  const res = await getPool().query<{ page_type: PageType; n: number }>(sql, [projectId]);
  const out: Record<PageType, number> = { blog: 0, service: 0, category: 0 };
  for (const r of res.rows) out[r.page_type] = r.n;
  return out;
}
