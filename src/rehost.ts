import { promises as fs } from "node:fs";
import path from "node:path";
import axios from "axios";

const IMAGES_ROOT = path.resolve(process.cwd(), "out", "images");

function safeBasename(s: string): string {
  return s.replace(/[^a-z0-9._-]+/gi, "_").replace(/_+/g, "_").slice(0, 120);
}

function extFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const m = /\.([a-zA-Z0-9]{2,5})$/.exec(u.pathname);
    if (m && m[1]) return m[1].toLowerCase();
  } catch {
    /* ignore */
  }
  return "png";
}

/**
 * Download `url` to ./out/images/<slug>/<safe(imageId)>.<ext>. Returns
 * the absolute path so the CSV can record exactly where the file lives.
 */
export async function downloadImage(params: {
  url: string;
  slug: string;
  /** S3 key or synthetic id — the filename is derived from this. */
  imageId: string;
}): Promise<string> {
  const dir = path.join(IMAGES_ROOT, params.slug);
  await fs.mkdir(dir, { recursive: true });

  const ext = extFromUrl(params.url);
  const filename = `${safeBasename(params.imageId)}.${ext}`;
  const target = path.join(dir, filename);

  const response = await axios.get<ArrayBuffer>(params.url, {
    responseType: "arraybuffer",
    timeout: 60_000,
  });
  await fs.writeFile(target, Buffer.from(response.data));
  return target;
}
