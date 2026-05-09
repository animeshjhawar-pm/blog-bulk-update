import { promises as fs } from "node:fs";
import path from "node:path";

const TOKEN_DIR = path.resolve(process.cwd(), "graphic-tokens");

export interface GraphicToken {
  [key: string]: unknown;
}

export function tokenPath(slug: string): string {
  return path.join(TOKEN_DIR, `${slug}.json`);
}

export async function loadToken(slug: string): Promise<GraphicToken | null> {
  try {
    const raw = await fs.readFile(tokenPath(slug), "utf8");
    return JSON.parse(raw) as GraphicToken;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function saveToken(slug: string, token: GraphicToken): Promise<string> {
  await fs.mkdir(TOKEN_DIR, { recursive: true });
  const target = tokenPath(slug);
  await fs.writeFile(target, JSON.stringify(token, null, 2) + "\n", "utf8");
  return target;
}

// ────────────────────────────────────────────────────────────────────────
// Per-client brand guidelines: freeform text the operator wants injected
// into every prompt's business_context. Lives at
// graphic-tokens/<slug>-brand.txt — gitignored, edited via the web UI.
// ────────────────────────────────────────────────────────────────────────

export function brandGuidelinesPath(slug: string): string {
  return path.join(TOKEN_DIR, `${slug}-brand.txt`);
}

export async function loadBrandGuidelines(slug: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(brandGuidelinesPath(slug), "utf8");
    return raw.trim() || null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function saveBrandGuidelines(slug: string, text: string): Promise<string> {
  await fs.mkdir(TOKEN_DIR, { recursive: true });
  const target = brandGuidelinesPath(slug);
  await fs.writeFile(target, (text ?? "").trim() + "\n", "utf8");
  return target;
}

// ────────────────────────────────────────────────────────────────────────
// Per-client overrides (e.g. operator-edited logo URL). Lives at
// graphic-tokens/<slug>-overrides.json so it persists across runs and is
// merged into the regen pipeline's project-info inputs.
// ────────────────────────────────────────────────────────────────────────

export interface ProjectOverrides {
  /** When set, overrides projects.logo_urls.primary_logo for prompts + UI. */
  logo_url?: string;
}

export function overridesPath(slug: string): string {
  return path.join(TOKEN_DIR, `${slug}-overrides.json`);
}

export async function loadProjectOverrides(slug: string): Promise<ProjectOverrides> {
  try {
    const raw = await fs.readFile(overridesPath(slug), "utf8");
    return JSON.parse(raw) as ProjectOverrides;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

export async function saveProjectOverrides(
  slug: string,
  patch: Partial<ProjectOverrides>,
): Promise<string> {
  await fs.mkdir(TOKEN_DIR, { recursive: true });
  const cur = await loadProjectOverrides(slug);
  const next = { ...cur, ...patch };
  // Drop empty-string values so saving "" actually clears the override.
  for (const k of Object.keys(next) as (keyof ProjectOverrides)[]) {
    if (typeof next[k] === "string" && (next[k] as string).trim() === "") delete next[k];
  }
  const target = overridesPath(slug);
  await fs.writeFile(target, JSON.stringify(next, null, 2) + "\n", "utf8");
  return target;
}
