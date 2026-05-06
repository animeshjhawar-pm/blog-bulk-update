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
