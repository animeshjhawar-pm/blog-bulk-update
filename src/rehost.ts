import { promises as fs } from "node:fs";
import path from "node:path";
import axios from "axios";

const LEGACY_IMAGES_ROOT = path.resolve(process.cwd(), "out", "images");
const RUNS_ROOT = path.resolve(process.cwd(), "out", "runs");

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
 * Download `url` to disk and return the absolute path so the CSV can
 * record exactly where the file lives.
 *
 * Layout:
 *   - With runId  → out/runs/<runId>/images/<safe(imageId)>.<ext>
 *   - Without     → out/images/<slug>/<safe(imageId)>.<ext>   (legacy)
 *
 * The per-runId layout makes the retention sweep (in web.ts) a clean
 * `rm -rf out/runs/<runId>/` and removes the cross-run-overwrite
 * footgun where two runs for the same client touching the same
 * imageId would clobber each other's files.
 */
export async function downloadImage(params: {
  url: string;
  slug: string;
  /** S3 key or synthetic id — the filename is derived from this. */
  imageId: string;
  /** Stable run id; when present, files live under out/runs/<runId>/images/. */
  runId?: string;
}): Promise<string> {
  const dir = params.runId
    ? path.join(RUNS_ROOT, params.runId, "images")
    : path.join(LEGACY_IMAGES_ROOT, params.slug);
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
