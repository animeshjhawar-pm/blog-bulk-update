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
  slug: string | null;
  additional_info: unknown;
  company_info: unknown;
  design_tokens: unknown;
  logo_urls: unknown;
}

/**
 * Reduce a slug to a domain-ish guess: dashes/underscores stripped,
 * lowercased. "spec-gas" → "specgas" matches a url like
 * "https://specgasinc.com" via ILIKE '%specgas%'.
 */
function slugDomainGuess(slug: string): string {
  return slug.replace(/[-_]/g, "").toLowerCase();
}

export async function lookupClient(slug: string): Promise<ProjectRow | null> {
  const sql = `
    SELECT id, name, url, slug,
           additional_info, company_info, design_tokens, logo_urls
    FROM projects
    WHERE slug = $1
       OR id::text = $1
       OR url ILIKE '%' || $2 || '%'
    LIMIT 1
  `;
  const res = await getPool().query<ProjectRow>(sql, [slug, slugDomainGuess(slug)]);
  return res.rows[0] ?? null;
}

export interface ClusterPageImage {
  image_id: string;
  description?: string;
  image_type?: string;
  context?: string;
  [key: string]: unknown;
}

/**
 * `page_info` is JSONB; the actual key set varies per project. We type
 * the well-known fields and leave the rest as `unknown` so pageInfo.ts
 * can probe the shape adaptively (cover/thumbnail layouts differ).
 */
export interface ClusterPageInfo {
  title?: string;
  topic?: string;
  images?: ClusterPageImage[];
  cover_image_id?: string;
  thumbnail_image_id?: string;
  cover?: ClusterPageImage | string;
  thumbnail?: ClusterPageImage | string;
  [key: string]: unknown;
}

export interface ClusterRow {
  id: string;
  topic: string | null;
  page_info: ClusterPageInfo | null;
  updated_at: Date;
}

export async function listPublishedBlogClusters(projectId: string): Promise<ClusterRow[]> {
  const sql = `
    SELECT id, topic, page_info, updated_at
    FROM clusters
    WHERE project_id = $1
      AND page_type = 'blog'
      AND status = 'published'
    ORDER BY updated_at DESC
  `;
  const res = await getPool().query<ClusterRow>(sql, [projectId]);
  return res.rows;
}
