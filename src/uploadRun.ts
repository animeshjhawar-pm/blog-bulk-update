import { promises as fs, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { runOutDir } from "./runOutDir.js";
import { openCsv, type CsvRow } from "./csv.js";
import { listPublishedClusters, lookupProjectById, type ProjectRow } from "./db.js";
import { collectImageRecords, type ImageRecord, type PageType } from "./pageInfo.js";
import { findClient } from "./clients.js";

/**
 * Upload-run pipeline. Parallel to regen.ts — same on-disk layout
 * (manifest + CSV + runs/<id>/images/<image_id>.<ext>), same Apply
 * pipeline downstream. The ONLY difference is the source of
 * image_local_path: regen subprocess writes Replicate output; upload
 * runs receive operator-dropped files via HTTP.
 *
 * Design choice — no subprocess. Building the CSV for an upload run
 * just needs a DB read + record collection + skeleton row writes,
 * which is fast enough to do in-line on the web request. That keeps
 * the regen flow (subprocess + log streaming + SSE) completely
 * untouched — regenPostHandler / startRegen / RunState are not
 * modified for upload runs.
 *
 * Manifest gets `mode: "upload"` so:
 *   - tryReconstructRunFromDisk plumbs the mode into RunState
 *   - runPage's render branch can swap the per-card preview to a
 *     drop-zone instead of a regenerated image
 *   - the recent-runs table can badge upload vs regen
 */

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB per image
const MIN_DIMENSION = 400;
const MAX_DIMENSION = 6000;

export type CanonicalMime = "image/jpeg" | "image/png" | "image/webp";

/** Extension → canonical MIME. Filename extension is advisory only;
 * magic bytes win at validation time. */
function canonicalExtFor(mime: CanonicalMime): "jpg" | "png" | "webp" {
  return mime === "image/jpeg" ? "jpg" : mime === "image/png" ? "png" : "webp";
}

/**
 * Magic-byte sniff. Returns the actual format the bytes ARE,
 * regardless of what the upload's Content-Type header claimed.
 * Caller compares this to the claimed type and rejects mismatches —
 * the #1 way malicious / mislabelled uploads sneak through.
 */
export function sniffImageFormat(buf: Buffer): CanonicalMime | null {
  if (buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) return "image/png";
  // WebP: "RIFF" .. .. .. .. "WEBP"
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return "image/webp";
  return null;
}

export interface UploadValidationResult {
  ok: true;
  /** Bytes to persist — possibly auto-rotated + EXIF-stripped, so
   * what the operator's browser preview shows matches what gets
   * served and ultimately uploaded to gushwork media-API. */
  bytes: Buffer;
  mime: CanonicalMime;
  ext: "jpg" | "png" | "webp";
  width: number;
  height: number;
  aspect: string;
  sha256: string;
  /** Filled when the dropped file's aspect doesn't match the slot's
   * expected aspect (within 5%). Non-fatal — UI surfaces it as a
   * yellow banner but accepts the upload. */
  aspect_warning?: string;
}

export interface UploadValidationError {
  ok: false;
  /** HTTP code the handler should return. */
  status: number;
  /** Operator-readable single-line reason. */
  error: string;
}

/**
 * Validate + canonicalise dropped bytes. Steps:
 *   1. Size cap (caller has usually already checked Content-Length,
 *      but this guards against bodies larger than headers claimed).
 *   2. Magic-byte sniff — establishes the ACTUAL format.
 *   3. sharp metadata probe — confirms the bytes are a parseable
 *      image and gives us width/height/format. Sharp ignores the
 *      filename extension; it trusts the decoder.
 *   4. Dimension floor/ceiling — 400px (too small to use) / 6000px
 *      (someone uploading a 50 MP camera raw).
 *   5. Auto-rotate via EXIF and re-encode in the same format so:
 *      - browsers + gushwork media API see the same orientation
 *      - EXIF (including GPS, camera serial, etc.) is stripped
 *      - multi-page / animated WebP collapses to a single frame
 *   6. Aspect comparison against the slot's expected aspect — warn,
 *      don't reject.
 *   7. sha256 for the sidecar (audit + dedup if we want it later).
 */
export async function validateAndCanonicalise(
  rawBytes: Buffer,
  expectedAspect: string | null,
): Promise<UploadValidationResult | UploadValidationError> {
  if (rawBytes.length === 0) return { ok: false, status: 400, error: "empty upload (0 bytes)" };
  if (rawBytes.length > MAX_UPLOAD_BYTES) {
    const mb = (rawBytes.length / 1024 / 1024).toFixed(1);
    return { ok: false, status: 413, error: `file too large (${mb} MB; max 10 MB). Compress and re-drop.` };
  }
  const sniffed = sniffImageFormat(rawBytes);
  if (!sniffed) {
    return {
      ok: false, status: 415,
      error: "unsupported file type — only PNG, JPEG, and WebP are accepted (this doesn't look like any of those).",
    };
  }
  let meta: sharp.Metadata;
  try {
    meta = await sharp(rawBytes).metadata();
  } catch (err) {
    return { ok: false, status: 422, error: `image bytes corrupt or unreadable: ${(err as Error).message}` };
  }
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (!w || !h) {
    return { ok: false, status: 422, error: "image has no detectable dimensions — file may be truncated" };
  }
  if (Math.min(w, h) < MIN_DIMENSION) {
    return {
      ok: false, status: 422,
      error: `image too small (${w}×${h}; minimum ${MIN_DIMENSION}px on the short edge)`,
    };
  }
  if (Math.max(w, h) > MAX_DIMENSION) {
    return {
      ok: false, status: 422,
      error: `image too large in pixel dimensions (${w}×${h}; maximum ${MAX_DIMENSION}px on the long edge — looks like a camera-raw export, re-export at web resolution)`,
    };
  }
  // sharp's metadata.format is one of: 'jpeg' | 'png' | 'webp' | 'gif' | 'avif' | 'tiff' | 'svg' | …
  // Cross-check against the magic-byte sniff; if they disagree, the
  // file's lying and we bail. This catches polyglots (file that
  // passes both a PDF parser and a JPEG decoder for example).
  const sharpFmt = meta.format;
  const sharpMime: CanonicalMime | null =
    sharpFmt === "jpeg" ? "image/jpeg" :
    sharpFmt === "png" ? "image/png" :
    sharpFmt === "webp" ? "image/webp" : null;
  if (!sharpMime || sharpMime !== sniffed) {
    return {
      ok: false, status: 415,
      error: `file format mismatch (magic bytes say ${sniffed}, decoder says ${sharpFmt ?? "?"}) — re-export the image as plain JPEG/PNG/WebP`,
    };
  }
  // Auto-rotate via EXIF + re-encode to drop EXIF / animation frames
  // beyond the first / colour-profile junk. Keep the same format —
  // changing format would force a quality decision we shouldn't make
  // on the operator's behalf (e.g. PNG → JPEG would lose transparency).
  let canonical: Buffer;
  try {
    const pipeline = sharp(rawBytes, { failOn: "warning" }).rotate();
    canonical = sharpMime === "image/jpeg"
      ? await pipeline.jpeg({ quality: 92, mozjpeg: true }).toBuffer()
      : sharpMime === "image/png"
        ? await pipeline.png({ compressionLevel: 9 }).toBuffer()
        : await pipeline.webp({ quality: 92 }).toBuffer();
  } catch (err) {
    return { ok: false, status: 422, error: `re-encode failed: ${(err as Error).message}` };
  }
  // Re-read dimensions after rotate — EXIF orientation 5–8 swap w/h.
  let finalW = w, finalH = h;
  try {
    const m2 = await sharp(canonical).metadata();
    finalW = m2.width ?? w;
    finalH = m2.height ?? h;
  } catch { /* keep originals */ }
  const aspectStr = simplifyAspect(finalW, finalH);
  let aspectWarning: string | undefined;
  if (expectedAspect) {
    const target = aspectToNumber(expectedAspect);
    const actual = finalW / finalH;
    if (Number.isFinite(target)) {
      const delta = Math.abs(actual - target) / target;
      // Tiered handling:
      //   0%-8%    silent accept (e.g. 1920x1080 → 16:9).
      //   8%-40%   warn (yellow banner) but ACCEPT. This band covers
      //            every reasonable landscape-to-landscape crop the
      //            operator might supply — 16:9 into a 3:2 thumbnail
      //            slot is 18.5%, 4:3 into 16:9 is 25%, 1:1 into 3:2
      //            is 33%. The downstream renderer fits/covers these;
      //            blocking them just stops legitimate uploads (the
      //            old 15% ceiling rejected the very common 16:9→3:2
      //            thumbnail case and made uploads "not work").
      //   >40%     REJECT. Only genuinely-wrong shapes land here —
      //            a square or portrait image dropped into a wide
      //            slot (1:1→16:9 is 44%, 9:16 portrait is far worse).
      //            Those aren't a crop, they're the wrong asset.
      if (delta > 0.40) {
        return {
          ok: false,
          status: 422,
          error: `aspect mismatch too large — slot expects ${expectedAspect}, you uploaded ${finalW}×${finalH} (~${aspectStr}, ${(delta * 100).toFixed(0)}% off). That's not a crop, it's the wrong shape (a square or portrait image into a wide slot). Re-export landscape to match before re-dropping.`,
        };
      }
      if (delta > 0.08) {
        aspectWarning = `aspect mismatch — slot expects ${expectedAspect}, you uploaded ${finalW}×${finalH} (~${aspectStr}, ${(delta * 100).toFixed(0)}% off). Accepted; the live page will fit/cover the difference.`;
      }
    }
  }
  const sha256 = createHash("sha256").update(canonical).digest("hex");
  return {
    ok: true,
    bytes: canonical,
    mime: sharpMime,
    ext: canonicalExtFor(sharpMime),
    width: finalW,
    height: finalH,
    aspect: aspectStr,
    sha256,
    aspect_warning: aspectWarning,
  };
}

function aspectToNumber(a: string): number {
  const m = /^(\d+)\s*:\s*(\d+)$/.exec(a.trim());
  if (!m) return Number.NaN;
  const n = Number(m[1]), d = Number(m[2]);
  return d ? n / d : Number.NaN;
}
function gcd(a: number, b: number): number { return b === 0 ? a : gcd(b, a % b); }
function simplifyAspect(w: number, h: number): string {
  if (!w || !h) return "?";
  const g = gcd(w, h);
  return `${w / g}:${h / g}`;
}

// ────────────────────────────────────────────────────────────────────────
// Upload-run sidecar — per-row state. Lives alongside manifest on
// the volume so re-drops and Apply both see consistent state.
// ────────────────────────────────────────────────────────────────────────

export interface UploadStateEntry {
  path: string;          // relative to runOutDir(), e.g. runs/<id>/images/<img>.webp
  size_bytes: number;
  mime: CanonicalMime;
  width: number;
  height: number;
  aspect: string;
  sha256: string;
  original_name: string;
  uploaded_at: string;
  aspect_warning?: string;
}

export interface UploadState {
  image_ids: Record<string, UploadStateEntry>;
}

function uploadStatePath(runId: string): string {
  return path.join(runOutDir(), `upload-state-${runId}.json`);
}

export async function loadUploadState(runId: string): Promise<UploadState> {
  try {
    const raw = await fs.readFile(uploadStatePath(runId), "utf8");
    const j = JSON.parse(raw) as Partial<UploadState>;
    return { image_ids: j.image_ids ?? {} };
  } catch {
    return { image_ids: {} };
  }
}

export async function saveUploadState(runId: string, s: UploadState): Promise<void> {
  const p = uploadStatePath(runId);
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), "utf8");
  await fs.rename(tmp, p);
}

// ────────────────────────────────────────────────────────────────────────
// Per-image file write / delete. Uses temp-then-rename so a partial
// write never appears at the final path.
// ────────────────────────────────────────────────────────────────────────

export function imagesDirFor(runId: string): string {
  return path.join(runOutDir(), "runs", runId, "images");
}

/**
 * Map an image_id to a safe filesystem basename. Image ids come in
 * two shapes:
 *   - media_registry UUIDs:  hex + hyphens, already safe
 *   - synthetic placeholders for missing cover/thumbnail ids:
 *       "cover-images/<cluster_id>" or "thumbnail-images/<cluster_id>"
 *       — these contain a forward slash, which would create a
 *       phantom subdir under runs/<id>/images/ and break the write.
 * Replace anything outside [a-zA-Z0-9._-] with "_". Resulting names
 * are deterministic per image_id; we never parse them back — lookup
 * always goes through the CSV row's image_id column.
 */
function safeFilenameForId(imageId: string): string {
  return imageId.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export async function writeUploadedImage(
  runId: string,
  imageId: string,
  bytes: Buffer,
  ext: "jpg" | "png" | "webp",
): Promise<string> {
  const dir = imagesDirFor(runId);
  await fs.mkdir(dir, { recursive: true });
  const safeName = safeFilenameForId(imageId);
  // Always wipe any prior file for this image_id regardless of ext —
  // a re-drop with a different format leaves at most one file.
  for (const e of ["jpg", "png", "webp"]) {
    const stale = path.join(dir, `${safeName}.${e}`);
    if (e !== ext) {
      try { await fs.rm(stale, { force: true }); } catch { /* */ }
    }
  }
  const finalPath = path.join(dir, `${safeName}.${ext}`);
  const tmp = `${finalPath}.tmp-${randomBytes(6).toString("hex")}`;
  await fs.writeFile(tmp, bytes);
  await fs.rename(tmp, finalPath);
  return finalPath;
}

export async function removeUploadedImage(runId: string, imageId: string): Promise<void> {
  const dir = imagesDirFor(runId);
  const safeName = safeFilenameForId(imageId);
  for (const ext of ["jpg", "png", "webp"]) {
    try { await fs.rm(path.join(dir, `${safeName}.${ext}`), { force: true }); } catch { /* */ }
  }
}

// ────────────────────────────────────────────────────────────────────────
// Upload-run start: build manifest + skeleton CSV from the same
// (cluster_ids, image_ids) shape the regen flow consumes.
// ────────────────────────────────────────────────────────────────────────

export interface UploadRunStartParams {
  client: string;             // client slug or project id
  pageType: PageType | PageType[];
  clusterIds?: Set<string>;
  imageIds?: Set<string>;
}

export interface UploadRunStartResult {
  runId: string;
  csvPath: string;
  manifestPath: string;
  rowCount: number;
}

export async function startUploadRun(params: UploadRunStartParams): Promise<UploadRunStartResult> {
  // Accept allow-list slug OR raw project UUID — same shape the
  // regen CLI accepts so the workspace can post either.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let entry = findClient(params.client);
  if (!entry && UUID_RE.test(params.client)) entry = { slug: params.client, projectId: params.client };
  if (!entry) throw new Error(`client "${params.client}" is not in the allow-list and is not a valid project UUID`);
  const slug = entry.slug;
  const project: ProjectRow | null = await lookupProjectById(entry.projectId);
  if (!project) throw new Error(`project not found for client="${slug}"`);

  const pageTypes = Array.isArray(params.pageType) ? params.pageType : [params.pageType];
  const clusters = await listPublishedClusters(project.id, pageTypes.length === 1 ? pageTypes[0]! : pageTypes);
  const records: ImageRecord[] = await collectImageRecords(clusters, {
    pageType: pageTypes.length === 1 ? pageTypes[0]! : undefined,
    clusterIds: params.clusterIds,
    imageIds: params.imageIds,
    stagingSubdomain: project.staging_subdomain,
  });
  if (records.length === 0) throw new Error("no image records matched the picked clusters/images");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "Z");
  const runId = randomBytes(8).toString("hex");
  const outDir = runOutDir();
  await fs.mkdir(outDir, { recursive: true });
  const csvPath = path.join(outDir, `${slug}-upload-${stamp}.csv`);
  const htmlPath = csvPath.replace(/\.csv$/, ".html");
  const manifestPath = path.join(outDir, `manifest-upload-${stamp}.json`);

  const csv = await openCsv(csvPath);
  const generatedAt = new Date().toISOString();
  for (const r of records) {
    const row: CsvRow = {
      image_id: r.imageId,
      asset_type: r.asset,
      cluster_id: r.cluster.id,
      page_topic: r.cluster.topic ?? "",
      // Both empty until the operator drops a file; the Apply
      // pipeline reads image_local_path so this is the only field
      // that needs filling later.
      image_url_new: "",
      image_local_path: "",
      description_used: r.description,
      prompt_used: "",
      aspect_ratio: r.aspectRatio,
      generated_at_utc: generatedAt,
      // "pending" until the operator drops a file; flips to
      // "ready" when the per-image upload handler updates the row.
      status: "pending",
      error: "",
      client_slug: slug,
      project_id: project.id,
      previous_image_url: r.previewUrl ?? "",
      prediction_id: "",
    };
    await csv.write(row);
  }
  await csv.close();

  // Write an empty HTML report so downstream code that probes for
  // htmlPath doesn't trip — the zip / download routes use this.
  await fs.writeFile(htmlPath, "<!-- upload run; no HTML report -->\n", "utf8");

  const manifest = {
    run_id: runId,
    mode: "upload" as const,
    client: slug,
    client_name: project.name,
    project_id: project.id,
    client_url: project.url ?? null,
    page_type: pageTypes,
    cluster_ids: params.clusterIds ? [...params.clusterIds] : null,
    image_ids: params.imageIds ? [...params.imageIds] : null,
    started_at: generatedAt,
    finished_at: null,
    csv: csvPath,
    csv_basename: path.basename(csvPath),
    html: htmlPath,
    html_basename: path.basename(htmlPath),
    total_rows: records.length,
    summary: { ok: 0, failed: 0 },
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  // Initialise empty sidecar so loadUploadState during the first
  // drop has a file to rename onto.
  await saveUploadState(runId, { image_ids: {} });

  return { runId, csvPath, manifestPath, rowCount: records.length };
}

// ────────────────────────────────────────────────────────────────────────
// Per-row CSV mutation — set image_local_path + status after a
// successful upload, OR clear them after a delete. We rewrite the
// whole CSV; it's small (one row per picked image, typically <500).
//
// Concurrency: two operators on the same run dropping files for
// different image_ids at the same time would otherwise race —
// each reads the CSV, mutates one row, writes back; the second
// write loses whatever the first wrote. Per-CSV in-process mutex
// (a Promise chain keyed by csvPath) serialises updates so each
// read sees the most recent write. Cross-process / cross-instance
// races aren't a concern because Railway runs one process per
// container and the volume is per-deployment.
// ────────────────────────────────────────────────────────────────────────
const CSV_WRITE_LOCKS = new Map<string, Promise<void>>();

async function withCsvLock<T>(csvPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = CSV_WRITE_LOCKS.get(csvPath) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  CSV_WRITE_LOCKS.set(csvPath, prev.then(() => gate));
  await prev;
  try {
    return await fn();
  } finally {
    release();
    // Best-effort cleanup so the map doesn't grow unbounded.
    queueMicrotask(() => {
      if (CSV_WRITE_LOCKS.get(csvPath) === prev.then(() => gate)) {
        CSV_WRITE_LOCKS.delete(csvPath);
      }
    });
  }
}

export async function updateCsvRowAfterUpload(
  csvPath: string,
  imageId: string,
  patch: { image_local_path?: string; status?: string; error?: string },
): Promise<void> {
  return withCsvLock(csvPath, () => updateCsvRowAfterUploadInner(csvPath, imageId, patch));
}

async function updateCsvRowAfterUploadInner(
  csvPath: string,
  imageId: string,
  patch: { image_local_path?: string; status?: string; error?: string },
): Promise<void> {
  const { parse: csvParse } = await import("csv-parse/sync");
  const { stringify: csvStringify } = await import("csv-stringify/sync");
  const raw = await fs.readFile(csvPath, "utf8");
  const rows = csvParse(raw, { columns: true, skip_empty_lines: true }) as Array<Record<string, string>>;
  let found = false;
  for (const r of rows) {
    if (r.image_id === imageId) {
      found = true;
      if (patch.image_local_path != null) r.image_local_path = patch.image_local_path;
      if (patch.status != null) r.status = patch.status;
      if (patch.error != null) r.error = patch.error;
    }
  }
  if (!found) throw new Error(`image_id ${imageId} not in CSV ${csvPath}`);
  const { CSV_HEADER } = await import("./csv.js");
  const out = csvStringify(rows, { header: true, columns: [...CSV_HEADER] });
  const tmp = `${csvPath}.tmp-${randomBytes(6).toString("hex")}`;
  await fs.writeFile(tmp, out, "utf8");
  await fs.rename(tmp, csvPath);
}
