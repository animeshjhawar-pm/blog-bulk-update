import "dotenv/config";
import { z } from "zod";

const Schema = z.object({
  DATABASE_URL: z.string().min(1),
  FIRECRAWL_API_KEY: z.string().min(1),
  PORTKEY_API_KEY: z.string().min(1),
  PORTKEY_CONFIG_ID: z.string().min(1).default("pc-portke-0dd3de"),
  REPLICATE_API_TOKEN: z.string().min(1).optional(),
  FAL_KEY: z.string().min(1).optional(),
  IMAGE_PROVIDER: z.enum(["replicate", "fal"]).default("replicate"),
});

export type Env = z.infer<typeof Schema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;

  const result = Schema.safeParse(process.env);
  if (!result.success) {
    const first = result.error.issues[0];
    const key = first?.path.join(".") ?? "?";
    process.stderr.write(
      `error: missing or invalid env var ${key} — ${first?.message ?? "see .env.example"}\n`,
    );
    process.exit(1);
  }

  const env = result.data;

  if (env.IMAGE_PROVIDER === "replicate" && !env.REPLICATE_API_TOKEN) {
    process.stderr.write("error: missing env var REPLICATE_API_TOKEN (IMAGE_PROVIDER=replicate)\n");
    process.exit(1);
  }
  if (env.IMAGE_PROVIDER === "fal" && !env.FAL_KEY) {
    process.stderr.write("error: missing env var FAL_KEY (IMAGE_PROVIDER=fal)\n");
    process.exit(1);
  }

  cached = env;
  return env;
}
