import { S3Client, GetObjectCommand, NoSuchKey } from "@aws-sdk/client-s3";
import { loadEnv } from "./env.js";

let _client: S3Client | null = null;

function client(): S3Client {
  if (_client) return _client;
  const env = loadEnv();
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
    throw new Error(
      "AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY missing in .env.local — required to fetch blog_with_image_placeholders.md from S3.",
    );
  }
  _client = new S3Client({
    region: env.AWS_REGION,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  });
  return _client;
}

/**
 * Path convention (confirmed against gw-stormbreaker on 2026-05-07):
 *   s3://<bucket>/page_data/<staging_subdomain>/blog/<cluster_id>/output/blog_with_image_placeholders.md
 *
 * The file is the canonical Shape A source — Markdown with embedded
 * <image_requirement id="..." type="..." alt="...">…</image_requirement>
 * tags, one per inline image in the blog post.
 */
export function blogPlaceholdersKey(stagingSubdomain: string, clusterId: string): string {
  return `page_data/${stagingSubdomain}/blog/${clusterId}/output/blog_with_image_placeholders.md`;
}

export interface FetchResult {
  body: string | null;
  notFound: boolean;
  bucket: string;
  key: string;
  bytes: number;
}

export async function fetchBlogPlaceholders(
  stagingSubdomain: string,
  clusterId: string,
): Promise<FetchResult> {
  const env = loadEnv();
  const bucket = env.S3_BUCKET;
  const key = blogPlaceholdersKey(stagingSubdomain, clusterId);
  try {
    const r = await client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = (await r.Body?.transformToString("utf8")) ?? null;
    return { body, notFound: false, bucket, key, bytes: body?.length ?? 0 };
  } catch (err) {
    if (err instanceof NoSuchKey || (err as { name?: string }).name === "NoSuchKey") {
      return { body: null, notFound: true, bucket, key, bytes: 0 };
    }
    throw err;
  }
}
