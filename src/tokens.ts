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

/**
 * Read ONLY the operator-writable layer (no fallback to the bundled
 * copy). Used by the resolver so a runtime dashboard edit can be
 * detected and given priority over both the DB row and the bundled
 * defaults; in production OPERATOR_DIR is a separate volume path, so
 * this distinguishes "operator edited at runtime" from "this is just
 * a committed default". On local dev where OPERATOR_DIR === BUNDLED_DIR
 * there is no separate layer to read from, so this returns null —
 * which is the correct behaviour: locally, edits land in the same
 * place as the bundled files and there's no "override" concept to honour.
 */
export async function loadOperatorToken(slug: string): Promise<GraphicToken | null> {
  if (OPERATOR_DIR === BUNDLED_DIR) return null;
  try {
    const raw = await fs.readFile(operatorPath(`${slug}.json`), "utf8");
    return JSON.parse(raw) as GraphicToken;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
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
  /**
   * Operator explicitly cleared the logo field and saved. This is
   * DISTINCT from "no override" (empty file): logo_disabled=true means
   * "generate with NO logo reference image at all", whereas an absent
   * override means "fall back to the DB-resolved brand logo". Without
   * this flag a cleared field just reset to the default.
   */
  logo_disabled?: boolean;
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
  // Drop every falsy value — empty-string logo_url, false logo_disabled,
  // undefined — so the persisted file only ever carries meaningful
  // settings. (Previously only blank strings were dropped, leaving
  // `false` booleans as noise.)
  for (const k of Object.keys(next) as (keyof ProjectOverrides)[]) {
    const v = next[k];
    if (v === "" || v === false || v == null
      || (typeof v === "string" && v.trim() === "")) {
      delete next[k];
    }
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
