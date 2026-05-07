import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// Load .env.local first (gitignored, real values), then .env as fallback.
// dotenv won't overwrite vars already set, so .env.local wins when both define a key.
loadDotenv({ path: ".env.local" });
loadDotenv();

// dotenv treats `FOO=` as setting FOO to "". For optional fields we want
// "no value" to mean undefined, so the .optional() default kicks in.
const emptyToUndef = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const Schema = z.object({
  DATABASE_URL: z.string().min(1),
  FIRECRAWL_API_KEY: z.string().min(1),
  PORTKEY_API_KEY: z.string().min(1),
  PORTKEY_CONFIG_ID: z.preprocess(emptyToUndef, z.string().min(1).default("pc-portke-0dd3de")),
  REPLICATE_API_TOKEN: z.preprocess(emptyToUndef, z.string().min(1).optional()),
  FAL_KEY: z.preprocess(emptyToUndef, z.string().min(1).optional()),
  IMAGE_PROVIDER: z.preprocess(emptyToUndef, z.enum(["replicate", "fal"]).default("replicate")),
  // AWS access for the blog_with_image_placeholders.md fetch.
  AWS_ACCESS_KEY_ID: z.preprocess(emptyToUndef, z.string().min(1).optional()),
  AWS_SECRET_ACCESS_KEY: z.preprocess(emptyToUndef, z.string().min(1).optional()),
  AWS_REGION: z.preprocess(emptyToUndef, z.string().min(1).default("us-east-1")),
  S3_BUCKET: z.preprocess(emptyToUndef, z.string().min(1).default("gw-stormbreaker")),
  /** Bucket where rendered blog images live (cover/thumbnail/inline). Apply
   * step writes here at `website/<staging>/assets/blog-images/<cluster>/<image_id>/{size}.webp`. */
  S3_CONTENT_BUCKET: z.preprocess(emptyToUndef, z.string().min(1).default("gw-content-store")),
});

export type Env = z.infer<typeof Schema>;

let cached: Env | null = null;

/** Throws on missing/invalid env. Callers decide how to surface the error. */
export function loadEnv(): Env {
  if (cached) return cached;

  const result = Schema.safeParse(process.env);
  if (!result.success) {
    const first = result.error.issues[0];
    const key = first?.path.join(".") ?? "?";
    throw new Error(
      `missing or invalid env var ${key} — ${first?.message ?? "see .env.example"}`,
    );
  }

  const env = result.data;

  if (env.IMAGE_PROVIDER === "replicate" && !env.REPLICATE_API_TOKEN) {
    throw new Error("missing env var REPLICATE_API_TOKEN (IMAGE_PROVIDER=replicate)");
  }
  if (env.IMAGE_PROVIDER === "fal" && !env.FAL_KEY) {
    throw new Error("missing env var FAL_KEY (IMAGE_PROVIDER=fal)");
  }

  cached = env;
  return env;
}

/**
 * Wrap a CLI entrypoint so missing-env errors print a one-liner to stderr
 * and exit non-zero (preserves the original CLI ergonomics).
 */
export function loadEnvOrExit(): Env {
  try {
    return loadEnv();
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
