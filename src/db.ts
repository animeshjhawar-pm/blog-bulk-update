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

export async function listPublishedBlogClusters(projectId: string): Promise<ClusterRow[]> {
  // Real schema: clusters.p_id (not project_id), clusters.page_status='PUBLISHED'
  // (uppercase), clusters.u_at (not updated_at).
  const sql = `
    SELECT id, topic, page_info, u_at AS updated_at
    FROM clusters
    WHERE p_id = $1::uuid
      AND page_type = 'blog'
      AND page_status = 'PUBLISHED'
    ORDER BY u_at DESC
  `;
  const res = await getPool().query<ClusterRow>(sql, [projectId]);
  return res.rows;
}
