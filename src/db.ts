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
  /**
   * Public-facing base URL for the live "feeds" experience. Pattern is
   * not consistent across clients:
   *   https://<root>/feeds         (Sentinel, SpecGas, Inzure, ACH)
   *   https://feeds.<root>         (Trussed)
   * The published-page URL is always `<canonical_url>/<page_type>/<slug>`.
   */
  canonical_url: string | null;
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
    SELECT id, name, url, staging_subdomain, canonical_url,
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

export type PageType = "blog" | "service" | "category";

export interface ClusterRow {
  id: string;
  topic: string | null;
  page_info: ClusterPageInfo | null;
  updated_at: Date;
  /** Which page_type this cluster belongs to. */
  page_type: PageType;
  /** clusters.slug — used to construct the published-page URL on the
   * cluster row's "View Published Page →" CTA. */
  slug: string | null;
}

/**
 * Real schema: clusters.p_id (not project_id), clusters.page_status='PUBLISHED'
 * (uppercase), clusters.u_at (not updated_at). Page-status filter is enforced
 * for every page_type — we never surface unpublished clusters in the UI.
 *
 * Accepts a single page_type or an array. When an array is passed the
 * results are merged in u_at-DESC order (newest first across types).
 */
export async function listPublishedClusters(
  projectId: string,
  pageType: PageType | PageType[] = "blog",
): Promise<ClusterRow[]> {
  const types = Array.isArray(pageType) ? pageType : [pageType];
  if (types.length === 0) return [];
  const sql = `
    SELECT id, topic, page_info, u_at AS updated_at, page_type, slug
    FROM clusters
    WHERE p_id = $1::uuid
      AND page_type = ANY($2::text[])
      AND page_status = 'PUBLISHED'
    ORDER BY u_at DESC
  `;
  const res = await getPool().query<ClusterRow>(sql, [projectId, types]);
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
  const hashIds: string[] = [];
  for (const id of imageIds) {
    if (UUID_RE.test(id)) uuids.push(id);
    else hashIds.push(id);
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

  // Hash-shaped image_ids (e.g. "1775738395157117_94580...") can live
  // under several key prefixes:
  //   generated-images/<hash>            (service H1, blog cover/infographic via flat layout)
  //   refined-images/<hash>              (service body or fallback service variants)
  //   blog-images/<cluster_id>/<hash>    (Sentinel-style blog images)
  // We don't always know the cluster up front, so do a single suffix
  // match — the trailing `/<hash>` is unique enough (timestamp + 32 hex).
  if (hashIds.length > 0) {
    // PostgreSQL doesn't support `LIKE ANY(...)` directly; we OR
    // against a small per-call set instead. With many IDs this builds
    // one statement with all `%/<id>` patterns.
    const patterns = hashIds.map((id) => `%/${id}`);
    const r = await pool.query<{ key: string; urls: MediaUrls }>(
      `SELECT key, urls FROM media_registry
       WHERE key LIKE ANY($1::text[])`,
      [patterns],
    );
    for (const row of r.rows) {
      // Map back to the original image_id by extracting the suffix
      // after the last "/".
      const orig = row.key.split("/").pop() ?? row.key;
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

/**
 * Bulk-fetch the slug + page_type for a set of cluster_ids — used by
 * the runs page so each result-card can link to its "View current page"
 * URL without round-tripping per-cluster.
 */
export interface ClusterSlugRow {
  id: string;
  slug: string | null;
  page_type: PageType;
}
export async function lookupClusterSlugs(clusterIds: string[]): Promise<Map<string, ClusterSlugRow>> {
  const out = new Map<string, ClusterSlugRow>();
  if (clusterIds.length === 0) return out;
  const sql = `
    SELECT id::text AS id, slug, page_type
    FROM clusters
    WHERE id = ANY($1::uuid[])
  `;
  const r = await getPool().query<ClusterSlugRow>(sql, [clusterIds]);
  for (const row of r.rows) out.set(row.id, row);
  return out;
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

// ────────────────────────────────────────────────────────────────────────
// Apply-to-S3 helpers: insert a fresh media_registry row + read/write a
// cluster's page_info. Used by the canonical apply pipeline (src/apply.ts).
// All three mirror behaviour in gw-backend-stormbreaker —
// services/postgres/stormbreaker/media_registry.py and the page_info
// updaters in handlers/create_pages/update_images.py.
// ────────────────────────────────────────────────────────────────────────

/**
 * Insert one media_registry row. Returns the new UUID. Matches
 * stormbreaker's `bulk_insert_media_entries` shape but for a single
 * row (we apply one image at a time, with `Promise.all` fan-out for
 * cluster + run scopes). The `urls` JSONB holds the per-size CDN
 * URLs; `key` is the canonical S3 key prefix (`blog-images/<cluster>/<hash>`
 * etc.) the rest of stormbreaker reads from.
 */
export async function insertMediaRegistry(args: {
  projectId: string;
  key: string;
  urls: Record<string, string>;
}): Promise<string> {
  const sql = `
    INSERT INTO media_registry (p_id, key, urls)
    VALUES ($1::uuid, $2, $3::jsonb)
    RETURNING id::text AS id
  `;
  const r = await getPool().query<{ id: string }>(sql, [
    args.projectId,
    args.key,
    JSON.stringify(args.urls),
  ]);
  if (!r.rows[0]) throw new Error("media_registry insert returned no row");
  return r.rows[0].id;
}

/**
 * Fetch the page_info of one cluster, plus enough metadata for the
 * apply pipeline to route correctly (page_type, project_id,
 * staging_subdomain). Keyed by cluster id so the apply path doesn't
 * have to re-fetch the parent project separately.
 */
export interface ClusterForApply {
  id: string;
  p_id: string;
  page_type: PageType;
  page_info: ClusterPageInfo;
  staging_subdomain: string | null;
}
export async function getClusterForApply(clusterId: string): Promise<ClusterForApply | null> {
  const sql = `
    SELECT c.id::text AS id, c.p_id::text AS p_id, c.page_type, c.page_info,
           p.staging_subdomain
    FROM clusters c
    JOIN projects p ON p.id = c.p_id
    WHERE c.id = $1::uuid
    LIMIT 1
  `;
  const r = await getPool().query<ClusterForApply>(sql, [clusterId]);
  return r.rows[0] ?? null;
}

/**
 * Overwrite a cluster's page_info with the supplied JSONB. The apply
 * pipeline reads, mutates the targeted image_id field (or rewrites
 * the matching <Image imageId="…"/> in blog_text.md), and persists
 * via this call. We update u_at to NOW() so any downstream consumers
 * that order by it see the fresh data.
 */
export async function updateClusterPageInfo(
  clusterId: string,
  pageInfo: unknown,
): Promise<void> {
  const sql = `
    UPDATE clusters
    SET page_info = $1::jsonb,
        u_at = NOW()
    WHERE id = $2::uuid
  `;
  await getPool().query(sql, [JSON.stringify(pageInfo), clusterId]);
}
