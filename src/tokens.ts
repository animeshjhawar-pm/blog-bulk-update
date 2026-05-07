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
