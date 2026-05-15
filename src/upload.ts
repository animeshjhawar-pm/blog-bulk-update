import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as csvParse } from "csv-parse/sync";
import { stringify as csvStringify } from "csv-stringify/sync";
import { loadEnv } from "./env.js";
import { closePool, lookupMediaRegistryForId, type MediaRegistryRow } from "./db.js";
import { makeLimiter } from "./concurrency.js";
import type { CsvRowParsed } from "./web-types.js";

/**
 * Upload-only integration.
 *
 * Reads a regen CSV, pushes each generated image through the Gushwork
 * media API (presign -> S3 PUT -> notify), waits for the backend to
 * mint the new media_registry row, and emits a mapping CSV
 * (old image_id -> new image_id / refined key / CDN urls).
 *
 * It does NOT touch page_info. The mapping CSV is the artifact the
 * future repoint step would consume; emitting it separately lets an
 * operator eyeball old->new before any production content is mutated.
 *
 * Readiness is detected by polling media_registry for the NEW
 * image_id (returned by step 1, before processing even finishes) until
 * its `urls` are populated. This is precise per-image — the public
 * `?process=image_update` poll is project-scoped and reports a stale
 * status, so we deliberately don't use it.
 */

const DEFAULT_BASE_URL = "https://api.gushwork.ai/seo-v2/project";

export interface UploadOptions {
  /** Path to the regen CSV to consume. */
  csvPath: string;
  /** Bearer token (already read from the token file by the caller). */
  token: string;
  /** Override the API base. Defaults to the prod seo-v2 project base. */
  baseUrl?: string;
  /** Pass refine=true to the presign call (native refinement flow). */
  refine: boolean;
  concurrency: number;
  /** Abort the whole run on the first row failure. Default false:
   * per-row failures are recorded and the run continues, matching
   * regen.ts's never-abort-mid-flight contract. */
  failFast: boolean;
  /** Output mapping-CSV path. Defaults next to the input CSV. */
  outPath?: string;
  /** Max wait for the media_registry row to appear (ms). */
  readyTimeoutMs?: number;
  readyIntervalMs?: number;
}

interface PresignResponse {
  url: string;
  upload_image_key: string;
  refined_image_key: string;
  /** The new media UUID — known up front, before processing finishes. */
  image_id: string;
}

export const MAPPING_HEADER = [
  "old_image_id",
  "asset_type",
  "cluster_id",
  "client_slug",
  "project_id",
  "page_topic",
  "new_image_id",
  "new_refined_key",
  "new_cdn_url_1080",
  "new_cdn_url_720",
  "new_cdn_url_360",
  "new_cdn_url_default",
  "source_used",
  "upload_status",
  "upload_error",
  "uploaded_at_utc",
  "old_regen_image_url",
] as const;
export type MappingRow = Record<(typeof MAPPING_HEADER)[number], string>;

/**
 * Source bytes: prefer the local file the regen run saved (no
 * Replicate-URL expiry risk), fall back to the remote image_url_new.
 * Mirrors apply.ts:readSourceBytes — local path must resolve under
 * cwd so a crafted CSV can't read arbitrary files.
 */
async function readSourceBytes(
  row: Pick<CsvRowParsed, "image_local_path" | "image_url_new">,
): Promise<{ bytes: Buffer; source: "local" | "remote" }> {
  const local = (row.image_local_path ?? "").trim();
  if (local) {
    const abs = path.resolve(local);
    const root = path.resolve(process.cwd());
    if (abs.startsWith(root)) {
      try {
        return { bytes: await fs.readFile(abs), source: "local" };
      } catch {
        /* fall through to remote */
      }
    }
  }
  const remote = (row.image_url_new ?? "").trim();
  if (!remote) {
    throw new Error("no usable source: image_local_path and image_url_new both empty/unreadable");
  }
  const resp = await fetch(remote);
  if (!resp.ok) throw new Error(`download ${remote} failed: HTTP ${resp.status}`);
  return { bytes: Buffer.from(await resp.arrayBuffer()), source: "remote" };
}

function extFor(row: CsvRowParsed): string {
  const fromLocal = path.extname(row.image_local_path ?? "").replace(".", "");
  if (fromLocal) return fromLocal.toLowerCase();
  try {
    const u = new URL(row.image_url_new);
    const m = /\.([a-z0-9]{2,5})$/i.exec(u.pathname);
    if (m) return m[1]!.toLowerCase();
  } catch {
    /* ignore */
  }
  return "png";
}

async function presign(
  base: string,
  projectId: string,
  token: string,
  fileName: string,
  fileSize: number,
  refine: boolean,
): Promise<PresignResponse> {
  const r = await fetch(`${base}/${projectId}/media/presigned-url`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fileName, fileSize, refine }),
  });
  if (!r.ok) throw new Error(`presigned-url HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = (await r.json()) as PresignResponse;
  if (!j.url || !j.upload_image_key || !j.image_id) {
    throw new Error(`presigned-url missing fields: got keys [${Object.keys(j).join(",")}]`);
  }
  return j;
}

async function putToS3(presignedUrl: string, bytes: Buffer): Promise<void> {
  const r = await fetch(presignedUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bytes.byteLength),
    },
    body: new Uint8Array(bytes),
  });
  if (!r.ok) throw new Error(`S3 PUT HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

async function notify(
  base: string,
  projectId: string,
  token: string,
  uploadKey: string,
  refinedKey: string,
): Promise<void> {
  const r = await fetch(`${base}/${projectId}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ upload_image_key: uploadKey, refined_image_key: refinedKey }),
  });
  if (!r.ok) throw new Error(`/media notify HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

/**
 * Poll media_registry for the new image_id until its row exists with
 * a populated urls map. Returns the row, or null on timeout.
 */
async function waitForMediaRow(
  imageId: string,
  timeoutMs: number,
  intervalMs: number,
): Promise<MediaRegistryRow | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await lookupMediaRegistryForId(imageId);
    if (row && row.urls && Object.keys(row.urls).length > 0) return row;
    if (Date.now() >= deadline) return null;
    await new Promise((res) => setTimeout(res, intervalMs));
  }
}

async function uploadOne(args: {
  row: CsvRowParsed;
  opts: UploadOptions;
  base: string;
  rowNum: number;
  total: number;
}): Promise<MappingRow> {
  const { row, opts, base, rowNum, total } = args;
  const projectId = (row.project_id ?? "").trim();
  const oldId = row.image_id;
  const blank: MappingRow = {
    old_image_id: oldId,
    asset_type: row.asset_type ?? "",
    cluster_id: row.cluster_id ?? "",
    client_slug: row.client_slug ?? "",
    project_id: projectId,
    page_topic: row.page_topic ?? "",
    new_image_id: "",
    new_refined_key: "",
    new_cdn_url_1080: "",
    new_cdn_url_720: "",
    new_cdn_url_360: "",
    new_cdn_url_default: "",
    source_used: "",
    upload_status: "failed",
    upload_error: "",
    uploaded_at_utc: "",
    old_regen_image_url: row.image_url_new ?? "",
  };

  if (!projectId) {
    return { ...blank, upload_status: "skipped", upload_error: "row has no project_id" };
  }

  try {
    const { bytes, source } = await readSourceBytes(row);
    const fileName = `${(oldId || "img").replace(/[^a-z0-9._-]+/gi, "_").slice(0, 80)}.${extFor(row)}`;

    const ps = await presign(base, projectId, opts.token, fileName, bytes.byteLength, opts.refine);
    await putToS3(ps.url, bytes);
    await notify(base, projectId, opts.token, ps.upload_image_key, ps.refined_image_key);

    const mr = await waitForMediaRow(
      ps.image_id,
      opts.readyTimeoutMs ?? 90_000,
      opts.readyIntervalMs ?? 3_000,
    );
    const urls = (mr?.urls ?? {}) as Record<string, string>;

    process.stderr.write(
      `[${rowNum}/${total}] ${oldId} -> ${ps.image_id} ${
        mr ? "ready" : "uploaded (media_registry not ready within timeout)"
      }\n`,
    );

    return {
      ...blank,
      new_image_id: ps.image_id,
      new_refined_key: ps.refined_image_key,
      new_cdn_url_1080: urls["1080"] ?? "",
      new_cdn_url_720: urls["720"] ?? "",
      new_cdn_url_360: urls["360"] ?? "",
      new_cdn_url_default: urls["default"] ?? "",
      source_used: source,
      upload_status: mr ? "uploaded" : "uploaded_unconfirmed",
      upload_error: mr ? "" : "media_registry row not visible within readyTimeoutMs",
      uploaded_at_utc: new Date().toISOString(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[${rowNum}/${total}] ${oldId} FAILED: ${msg}\n`);
    if (opts.failFast) throw new Error(`row ${oldId}: ${msg}`);
    return { ...blank, upload_status: "failed", upload_error: msg };
  }
}

/**
 * In-memory core: take already-parsed regen rows, upload the
 * uploadable ones, return the mapping rows. No file/pool side effects
 * — the web UI calls this directly with rows from readRunCsv; the CLI
 * wrapper handles CSV read/write + pool close around it.
 */
export async function uploadRows(
  allRows: CsvRowParsed[],
  opts: UploadOptions,
): Promise<{ mapping: MappingRow[]; uploadable: number; skipped: number; aborted: Error | null }> {
  const base = opts.baseUrl ?? DEFAULT_BASE_URL;
  const rows = allRows.filter(
    (r) =>
      (r.status ?? "").trim() === "completed" &&
      ((r.image_local_path ?? "").trim() || (r.image_url_new ?? "").trim()),
  );
  const skipped = allRows.length - rows.length;
  if (rows.length === 0) {
    return { mapping: [], uploadable: 0, skipped, aborted: null };
  }

  const limit = makeLimiter(opts.concurrency);
  const results: MappingRow[] = new Array(rows.length);
  const abortBox: { err: Error | null } = { err: null };

  await Promise.all(
    rows.map((row, i) =>
      limit(async () => {
        if (abortBox.err) return;
        try {
          results[i] = await uploadOne({ row, opts, base, rowNum: i + 1, total: rows.length });
        } catch (err) {
          abortBox.err = err instanceof Error ? err : new Error(String(err)); // only thrown when failFast
        }
      }),
    ),
  );

  return {
    mapping: results.filter(Boolean),
    uploadable: rows.length,
    skipped,
    aborted: abortBox.err,
  };
}

export async function runUpload(opts: UploadOptions): Promise<void> {
  loadEnv(); // ensures DATABASE_URL is present for the readiness poll

  const raw = await fs.readFile(opts.csvPath, "utf8");
  const all = csvParse(raw, { columns: true, skip_empty_lines: true }) as CsvRowParsed[];

  const { mapping: written, uploadable, skipped, aborted } = await uploadRows(all, opts);
  process.stderr.write(
    `upload: ${all.length} CSV rows, ${uploadable} uploadable, ${skipped} skipped (not completed / no image)\n`,
  );
  if (written.length === 0) {
    process.stderr.write("upload: nothing to do\n");
    await closePool();
    return;
  }

  const outPath =
    opts.outPath ??
    opts.csvPath.replace(/\.csv$/i, "") + `-uploaded-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  await fs.writeFile(
    outPath,
    csvStringify(written, { header: true, columns: [...MAPPING_HEADER] }),
    "utf8",
  );

  const ok = written.filter((r) => r.upload_status === "uploaded").length;
  const unconfirmed = written.filter((r) => r.upload_status === "uploaded_unconfirmed").length;
  const failed = written.filter((r) => r.upload_status === "failed").length;
  const skippedRows = written.filter((r) => r.upload_status === "skipped").length;

  await closePool();
  process.stderr.write(
    `upload: done — ${ok} ok, ${unconfirmed} uploaded-unconfirmed, ${failed} failed, ${skippedRows} skipped\n` +
      `upload: mapping CSV = ${outPath}\n`,
  );
  if (aborted) {
    process.stderr.write(`upload: ABORTED (--fail-fast) — ${aborted.message}\n`);
    process.exitCode = 1;
  }
}
