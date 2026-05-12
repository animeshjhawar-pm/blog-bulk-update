import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Two-layer token store.
 *
 *   BUNDLED_DIR  — `./graphic-tokens/` inside the repo. Read-only.
 *                  Ships with the deploy and holds the 5 curated
 *                  featured-client tokens (sentinel, specgas, …).
 *
 *   OPERATOR_DIR — Read-write. Anything saved at runtime (extracts
 *                  triggered from the workspace UI, brand-guideline
 *                  edits, logo overrides) lives here. Defaults to
 *                  BUNDLED_DIR for local dev so behaviour is
 *                  unchanged. On Railway, set
 *                      GRAPHIC_TOKEN_DIR=/data/graphic-tokens
 *                  and mount a persistent volume at /data — then
 *                  every extracted token survives redeploys and is
 *                  shared across instances, exactly like the 5
 *                  featured ones.
 *
 * Reads try OPERATOR_DIR first, fall back to BUNDLED_DIR. Writes
 * always target OPERATOR_DIR. The two-layer setup means an operator
 * can override a bundled token without touching git — useful for
 * tweaking the featured-client palettes per-deploy.
 */
const BUNDLED_DIR = path.resolve(process.cwd(), "graphic-tokens");
const OPERATOR_DIR = path.resolve(process.env.GRAPHIC_TOKEN_DIR ?? BUNDLED_DIR);

export interface GraphicToken {
  [key: string]: unknown;
}

/** Resolve the operator-layer path for a given filename (slug+suffix). */
function operatorPath(filename: string): string {
  return path.join(OPERATOR_DIR, filename);
}
function bundledPath(filename: string): string {
  return path.join(BUNDLED_DIR, filename);
}

/**
 * Layered read: prefer the operator-writable directory, fall back to
 * the bundled directory. Returns null when neither has the file.
 */
async function readLayered(filename: string): Promise<string | null> {
  // Try operator dir first (a saved override beats the bundled copy).
  if (OPERATOR_DIR !== BUNDLED_DIR) {
    try {
      return await fs.readFile(operatorPath(filename), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  try {
    return await fs.readFile(bundledPath(filename), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** All writes go to OPERATOR_DIR — never mutate the bundled layer. */
async function writeOperator(filename: string, content: string): Promise<string> {
  await fs.mkdir(OPERATOR_DIR, { recursive: true });
  const target = operatorPath(filename);
  await fs.writeFile(target, content, "utf8");
  return target;
}

/**
 * Path the operator layer WOULD write to. The web UI surfaces this in
 * its "saved at" status. Doesn't promise the file exists.
 */
export function tokenPath(slug: string): string {
  return operatorPath(`${slug}.json`);
}

export async function loadToken(slug: string): Promise<GraphicToken | null> {
  const raw = await readLayered(`${slug}.json`);
  if (raw == null) return null;
  return JSON.parse(raw) as GraphicToken;
}

export async function saveToken(slug: string, token: GraphicToken): Promise<string> {
  return writeOperator(`${slug}.json`, JSON.stringify(token, null, 2) + "\n");
}

// ────────────────────────────────────────────────────────────────────────
// Per-client brand guidelines: freeform text the operator wants injected
// into every prompt as additional_instructions. Lives at
// <DIR>/<slug>-brand.txt — gitignored, edited via the web UI.
// ────────────────────────────────────────────────────────────────────────

export function brandGuidelinesPath(slug: string): string {
  return operatorPath(`${slug}-brand.txt`);
}

export async function loadBrandGuidelines(slug: string): Promise<string | null> {
  const raw = await readLayered(`${slug}-brand.txt`);
  if (raw == null) return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

export async function saveBrandGuidelines(slug: string, text: string): Promise<string> {
  return writeOperator(`${slug}-brand.txt`, (text ?? "").trim() + "\n");
}

// ────────────────────────────────────────────────────────────────────────
// Per-client overrides (e.g. operator-edited logo URL). Lives at
// <DIR>/<slug>-overrides.json so it persists across runs and is
// merged into the regen pipeline's project-info inputs.
// ────────────────────────────────────────────────────────────────────────

export interface ProjectOverrides {
  /** When set, overrides projects.logo_urls.primary_logo for prompts + UI. */
  logo_url?: string;
}

export function overridesPath(slug: string): string {
  return operatorPath(`${slug}-overrides.json`);
}

export async function loadProjectOverrides(slug: string): Promise<ProjectOverrides> {
  const raw = await readLayered(`${slug}-overrides.json`);
  if (raw == null) return {};
  return JSON.parse(raw) as ProjectOverrides;
}

export async function saveProjectOverrides(
  slug: string,
  patch: Partial<ProjectOverrides>,
): Promise<string> {
  const cur = await loadProjectOverrides(slug);
  const next: ProjectOverrides = { ...cur, ...patch };
  for (const k of Object.keys(next) as (keyof ProjectOverrides)[]) {
    if (typeof next[k] === "string" && (next[k] as string).trim() === "") delete next[k];
  }
  return writeOperator(`${slug}-overrides.json`, JSON.stringify(next, null, 2) + "\n");
}

/**
 * Diagnostic for the boot log so operators can confirm which layout
 * is active without grepping env vars.
 */
export function tokenStoreLayout(): { bundled: string; operator: string; layered: boolean } {
  return { bundled: BUNDLED_DIR, operator: OPERATOR_DIR, layered: BUNDLED_DIR !== OPERATOR_DIR };
}
