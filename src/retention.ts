import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Run-artefact retention.
 *
 * A run produces, on disk:
 *   out/manifest-<stamp>.json   — the index entry (small)
 *   out/<slug>-<stamp>.csv       — the row data (small)
 *   out/<slug>-<stamp>.html      — the static report (small)
 *   out/runs/<runId>/images/…    — the generated images (the big one)
 *
 * To keep Railway disk bounded we evict old runs on two axes —
 * whichever bound trips first wins.
 *
 *   retentionHours  — wall-clock age cap (default 7 days)
 *   maxRunsKept     — count cap, ordered newest-first (default 50)
 *
 * Both are env-overridable so a deployment can tighten or relax them
 * without a code change:
 *   DOWNLOAD_RETENTION_HOURS, MAX_RUNS_KEPT
 *
 * The sweep is best-effort: any per-file delete failure is logged and
 * doesn't abort the rest of the pass. Concurrent downloads of a file
 * mid-deletion are a non-issue because `unlink` doesn't invalidate
 * already-open file descriptors on Linux — the read stream finishes,
 * the file just stops being visible in subsequent `readdir`.
 */

export interface RetentionConfig {
  retentionHours: number;
  maxRunsKept: number;
  /** How long a Replicate output URL is treated as potentially live.
   * Defaults to 1h — past this point, openImageStream skips the
   * remote fallback to avoid burning a TCP timeout on every miss. */
  replicateUrlTtlHours: number;
}

export function loadRetentionConfig(): RetentionConfig {
  const hours = Number.parseInt(process.env.DOWNLOAD_RETENTION_HOURS ?? "", 10);
  const max = Number.parseInt(process.env.MAX_RUNS_KEPT ?? "", 10);
  const repl = Number.parseFloat(process.env.REPLICATE_URL_TTL_HOURS ?? "");
  return {
    retentionHours: Number.isFinite(hours) && hours > 0 ? hours : 168, // 7 days
    maxRunsKept: Number.isFinite(max) && max > 0 ? max : 50,
    replicateUrlTtlHours: Number.isFinite(repl) && repl > 0 ? repl : 1,
  };
}

interface ManifestEntry {
  manifestPath: string;
  runId: string | null;
  startedAtMs: number;
  csvPath: string | null;
  htmlPath: string | null;
}

async function readManifest(p: string): Promise<ManifestEntry | null> {
  try {
    const raw = await fs.readFile(p, "utf8");
    const j = JSON.parse(raw) as {
      run_id?: unknown; started_at?: unknown; csv?: unknown; html?: unknown;
    };
    const startedAt = typeof j.started_at === "string" ? Date.parse(j.started_at) : NaN;
    return {
      manifestPath: p,
      runId: typeof j.run_id === "string" ? j.run_id : null,
      startedAtMs: Number.isFinite(startedAt) ? startedAt : 0,
      csvPath: typeof j.csv === "string" ? j.csv : null,
      htmlPath: typeof j.html === "string" ? j.html : null,
    };
  } catch {
    return null;
  }
}

async function rmIfExists(p: string | null | undefined): Promise<void> {
  if (!p) return;
  try {
    await fs.rm(p, { force: true, recursive: false });
  } catch (err) {
    process.stderr.write(`retention: rm failed for ${p}: ${(err as Error).message}\n`);
  }
}
async function rmrfIfExists(p: string): Promise<void> {
  try {
    await fs.rm(p, { force: true, recursive: true });
  } catch (err) {
    process.stderr.write(`retention: rmrf failed for ${p}: ${(err as Error).message}\n`);
  }
}

export interface SweepResult {
  scanned: number;
  evicted: number;
  bytesFreed: number;
  reasonByRun: Record<string, "age" | "count">;
  /** Per-run-id image dirs that had no surviving manifest (orphans). */
  orphanRunsDeleted: number;
  /** Legacy images (out/images/<slug>/<file>) no manifest's CSV references. */
  legacyImagesDeleted: number;
}

async function dirSize(p: string): Promise<number> {
  let total = 0;
  try {
    const entries = await fs.readdir(p, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) total += await dirSize(full);
      else {
        try { total += (await fs.stat(full)).size; } catch { /* ignore */ }
      }
    }
  } catch { /* dir missing */ }
  return total;
}

/**
 * Run one retention pass. Idempotent — safe to call repeatedly. Skips
 * runs that are currently kept (in either bound) and evicts the rest
 * by deleting the four artefacts (images dir, csv, html, manifest).
 */
export async function sweepRunRetention(
  cfg: RetentionConfig = loadRetentionConfig(),
  outDir: string = path.resolve(process.cwd(), "out"),
): Promise<SweepResult> {
  const result: SweepResult = {
    scanned: 0,
    evicted: 0,
    bytesFreed: 0,
    reasonByRun: {},
    orphanRunsDeleted: 0,
    legacyImagesDeleted: 0,
  };

  let names: string[];
  try {
    names = await fs.readdir(outDir);
  } catch {
    return result; // no out dir yet
  }
  const manifestNames = names.filter((n) => n.startsWith("manifest-") && n.endsWith(".json"));
  const entries: ManifestEntry[] = [];
  for (const n of manifestNames) {
    const e = await readManifest(path.join(outDir, n));
    if (e) entries.push(e);
  }
  result.scanned = entries.length;

  // Sort newest first so the count bound keeps the most recent runs.
  entries.sort((a, b) => b.startedAtMs - a.startedAtMs);

  const now = Date.now();
  const ageCutoffMs = now - cfg.retentionHours * 3600 * 1000;
  const toEvict: Array<{ entry: ManifestEntry; reason: "age" | "count" }> = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (i >= cfg.maxRunsKept) {
      toEvict.push({ entry: e, reason: "count" });
      continue;
    }
    if (e.startedAtMs > 0 && e.startedAtMs < ageCutoffMs) {
      toEvict.push({ entry: e, reason: "age" });
    }
  }

  for (const { entry, reason } of toEvict) {
    const runImagesDir = entry.runId ? path.join(outDir, "runs", entry.runId) : null;
    let freed = 0;
    if (runImagesDir) freed += await dirSize(runImagesDir);
    for (const p of [entry.csvPath, entry.htmlPath]) {
      if (p) {
        try { freed += (await fs.stat(p)).size; } catch { /* missing */ }
      }
    }

    // Delete images dir first (the big payload), then small files, then
    // the manifest last so a crash mid-sweep doesn't leave a manifest
    // pointing at half-deleted state.
    if (runImagesDir) await rmrfIfExists(runImagesDir);
    await rmIfExists(entry.csvPath);
    await rmIfExists(entry.htmlPath);
    await rmIfExists(entry.manifestPath);

    result.evicted++;
    result.bytesFreed += freed;
    if (entry.runId) result.reasonByRun[entry.runId] = reason;
  }

  // ── 2. Orphan run directories ──────────────────────────────────────
  // out/runs/<runId>/ folders whose manifest has been deleted (or
  // was never written — e.g. the CLI crashed mid-startup) are
  // unreferenced and can be reclaimed. Cross-check against the
  // *remaining* manifests after step 1.
  const remainingRunIds = new Set<string>();
  for (const e of entries) {
    if (e.runId && !toEvict.find((x) => x.entry.manifestPath === e.manifestPath)) {
      remainingRunIds.add(e.runId);
    }
  }
  const runsRoot = path.join(outDir, "runs");
  try {
    const runDirs = await fs.readdir(runsRoot, { withFileTypes: true });
    for (const d of runDirs) {
      if (!d.isDirectory()) continue;
      if (remainingRunIds.has(d.name)) continue;
      const p = path.join(runsRoot, d.name);
      const sz = await dirSize(p);
      await rmrfIfExists(p);
      result.orphanRunsDeleted++;
      result.bytesFreed += sz;
    }
  } catch { /* runsRoot may not exist yet */ }

  // ── 3. Legacy out/images/<slug>/<file> cleanup ────────────────────
  // Files written by older versions (and any future CLI runs that
  // don't pass --run-id) live here. Build the set of paths currently
  // referenced by any surviving manifest's CSV, then delete any
  // legacy file that ISN'T referenced. This is cheap because each
  // CSV is tiny; we never load image bytes.
  try {
    const refSet = await buildLegacyRefSet(outDir, entries.filter((e) =>
      !toEvict.find((x) => x.entry.manifestPath === e.manifestPath)));
    const legacyRoot = path.join(outDir, "images");
    const slugDirs = await fs.readdir(legacyRoot, { withFileTypes: true });
    for (const sd of slugDirs) {
      if (!sd.isDirectory()) continue;
      const slugDir = path.join(legacyRoot, sd.name);
      const files = await fs.readdir(slugDir);
      for (const f of files) {
        const full = path.join(slugDir, f);
        if (refSet.has(full)) continue;
        let sz = 0;
        try { sz = (await fs.stat(full)).size; } catch { /* */ }
        await rmIfExists(full);
        result.legacyImagesDeleted++;
        result.bytesFreed += sz;
      }
      // If the slug dir is now empty, remove it.
      try {
        const leftover = await fs.readdir(slugDir);
        if (leftover.length === 0) await fs.rmdir(slugDir);
      } catch { /* */ }
    }
  } catch { /* legacy dir may not exist */ }

  return result;
}

/**
 * Parse every surviving manifest's CSV once and return the set of
 * `image_local_path` values currently referenced. Used to decide
 * which legacy image files are safe to delete.
 */
async function buildLegacyRefSet(_outDir: string, surviving: ManifestEntry[]): Promise<Set<string>> {
  const refs = new Set<string>();
  for (const e of surviving) {
    if (!e.csvPath) continue;
    let raw: string;
    try { raw = await fs.readFile(e.csvPath, "utf8"); } catch { continue; }
    // We only need the `image_local_path` column — cheap text scan
    // beats pulling in a CSV parser here.
    const lines = raw.split("\n");
    if (lines.length === 0) continue;
    const header = lines[0]!.split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
    const idx = header.indexOf("image_local_path");
    if (idx < 0) continue;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      // Naive CSV split — image_local_path doesn't contain commas or
      // quotes in practice (it's a filesystem path written by us).
      const cols = line.split(",");
      const cell = (cols[idx] ?? "").trim().replace(/^"|"$/g, "");
      if (cell) refs.add(path.resolve(cell));
    }
  }
  return refs;
}

/**
 * Compute when a given run's downloads stop being available. The web
 * UI renders this on the run page so operators know what window
 * they're working in.
 */
export function expiryForRun(args: {
  startedAt: string | null | undefined;
  cfg?: RetentionConfig;
}): { expiresAt: Date | null; hoursLeft: number | null } {
  if (!args.startedAt) return { expiresAt: null, hoursLeft: null };
  const t = Date.parse(args.startedAt);
  if (!Number.isFinite(t)) return { expiresAt: null, hoursLeft: null };
  const cfg = args.cfg ?? loadRetentionConfig();
  const expiresMs = t + cfg.retentionHours * 3600 * 1000;
  const hoursLeft = Math.max(0, Math.round((expiresMs - Date.now()) / 3600 / 1000));
  return { expiresAt: new Date(expiresMs), hoursLeft };
}
