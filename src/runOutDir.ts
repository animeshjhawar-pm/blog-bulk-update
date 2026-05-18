import path from "node:path";

/**
 * Resolve the directory where run artefacts (manifest-*.json, the
 * per-run csv/html, and out/runs/<id>/images/) get written and read.
 *
 * Reads RUN_OUT_DIR directly from process.env so this helper has no
 * dependency on env.ts's lazy zod validator (it gets called during
 * module init in places like retention.ts default args, before
 * loadEnv() may have run). Empty / unset env -> default <cwd>/out.
 *
 * Why this exists: on Railway, <cwd>/out lives on the container's
 * ephemeral filesystem and is wiped on every deploy. Setting
 * RUN_OUT_DIR=/data/runs (with a mounted Volume) keeps past runs.
 */
export function runOutDir(): string {
  const v = (process.env.RUN_OUT_DIR ?? "").trim();
  return v ? path.resolve(v) : path.resolve(process.cwd(), "out");
}
