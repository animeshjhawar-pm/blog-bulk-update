import { promises as fs } from "node:fs";
import path from "node:path";
import { runOutDir } from "./runOutDir.js";
import { ATOMIC_TMP_PREFIX } from "./atomicWrite.js";

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

// Disk-backed proof-of-life sentinel for live upload-generate
// sessions. Written by web.ts::touchSessionSentinel at session start
// and on every product drop. Kept in sync with the same-named const
// in web.ts. The 24h TTL is a coarse "operator hasn't come back"
// timeout — enough for someone to drop files, close their laptop, and
// resume next morning, but not so long that abandoned sessions
// accumulate forever.
export const SESSION_SENTINEL_NAME = ".in-progress";
export const SESSION_SENTINEL_TTL_MS = 24 * 60 * 60 * 1000;

export interface RetentionConfig {
  /** RECORD cap — manifest + csv + html. A run "exists" as long as its
   *  record does (it stays in the runs list, the CSV is inspectable,
   *  the run page renders). These artefacts are tiny (~100 KB/run). */
  retentionHours: number;
  maxRunsKept: number;
  /** IMAGE cap — the runs/<id>/images/ directory, the heavy payload.
   *  Pruned on a tighter window than the record. A run whose images
   *  are pruned still shows in the list and renders; only the per-image
   *  previews / downloads are gone (the /preview endpoint 410s). */
  imageRetentionHours: number;
  imageMaxRunsKept: number;
  /** PRODUCT cap — products-<runId>/ and wireframes-<runId>/ dirs
   *  (operator-uploaded product photos + custom wireframes for
   *  upload-generate runs). Age only, no count bound. Separate from the
   *  image window so product photos can be pruned sooner than generated
   *  image previews. Past this window, per-image Regenerate on that
   *  upload-generate run returns the existing 410 "product no longer
   *  available". */
  productRetentionHours: number;
  /** How long a Replicate output URL is treated as potentially live.
   * Defaults to 1h — past this point, openImageStream skips the
   * remote fallback to avoid burning a TCP timeout on every miss. */
  replicateUrlTtlHours: number;
}

export function loadRetentionConfig(): RetentionConfig {
  const hours = Number.parseInt(process.env.DOWNLOAD_RETENTION_HOURS ?? "", 10);
  const max = Number.parseInt(process.env.MAX_RUNS_KEPT ?? "", 10);
  const imgHours = Number.parseInt(process.env.IMAGE_RETENTION_HOURS ?? "", 10);
  const imgMax = Number.parseInt(process.env.IMAGE_MAX_RUNS_KEPT ?? "", 10);
  const repl = Number.parseFloat(process.env.REPLICATE_URL_TTL_HOURS ?? "");
  const prodHours = Number.parseInt(process.env.PRODUCT_RETENTION_HOURS ?? "", 10);
  return {
    // RECORD retention — very long. The manifest + csv are tiny, so a
    // run can "stay" (visible, inspectable) for a year / 5000 runs
    // without meaningful disk cost. This is what makes runs survive
    // deploys AND survive the sweep — the operator asked for runs to
    // persist, and the record is what persists.
    retentionHours: Number.isFinite(hours) && hours > 0 ? hours : 8760, // 1 year
    maxRunsKept: Number.isFinite(max) && max > 0 ? max : 5000,
    // IMAGE retention — tighter. The runs/<id>/images/ dirs are the
    // disk hog; pruning them keeps the volume bounded. Defaults: keep
    // the last 150 runs' images, or 14 days, whichever trips first.
    imageRetentionHours: Number.isFinite(imgHours) && imgHours > 0 ? imgHours : 336, // 14 days
    imageMaxRunsKept: Number.isFinite(imgMax) && imgMax > 0 ? imgMax : 150,
    replicateUrlTtlHours: Number.isFinite(repl) && repl > 0 ? repl : 1,
    // PRODUCT retention — 48h (set 2026-09-11). Product photos are
    // 100-350 MB per run and upload-generate adds ~850 MB/day, so they
    // dominate disk growth; 48h rather than the 72h image window.
    // PRODUCT_RETENTION_HOURS overrides without a redeploy.
    productRetentionHours: Number.isFinite(prodHours) && prodHours > 0 ? prodHours : 48,
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
  /** Runs fully evicted — record + images gone (past the long window). */
  evicted: number;
  /** Runs that kept their record but had the heavy images dir pruned. */
  imagesOnlyPruned: number;
  bytesFreed: number;
  reasonByRun: Record<string, "age" | "count">;
  /** Per-run-id image dirs that had no surviving manifest (orphans). */
  orphanRunsDeleted: number;
  /** Legacy images (out/images/<slug>/<file>) no manifest's CSV references. */
  legacyImagesDeleted: number;
}

/**
 * How long an atomic-write staging file has to sit before it counts as
 * an orphan. 6h, not minutes: a young staging file may belong to a
 * write still in flight (a large product photo on a slow volume), and
 * deleting it would corrupt the very write this machinery protects. No
 * legitimate write takes hours.
 */
const ATOMIC_TMP_TTL_MS = 6 * 3600 * 1000;

/**
 * Recursively collect `.atomic-tmp-*` files left behind when a process
 * died between writeFileAtomic's write and its rename. Depth-capped at
 * the deepest nesting this tree actually has:
 *   outDir(0) / runs(1) / <runId>(2) / images(3)
 */
async function sweepAtomicTmpFiles(
  dir: string,
  cutoffMs: number,
  depth = 0,
): Promise<{ deleted: number; bytes: number }> {
  const out = { deleted: 0, bytes: 0 };
  if (depth > 4) return out;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out; // dir missing or unreadable — nothing to do
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const sub = await sweepAtomicTmpFiles(p, cutoffMs, depth + 1);
      out.deleted += sub.deleted;
      out.bytes += sub.bytes;
      continue;
    }
    if (!e.name.startsWith(ATOMIC_TMP_PREFIX)) continue;
    const st = await fs.stat(p).catch(() => null);
    if (!st || st.mtimeMs >= cutoffMs) continue;
    await rmIfExists(p);
    out.deleted++;
    out.bytes += st.size;
  }
  return out;
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
  outDir: string = runOutDir(),
  // runIds that are live in-memory (upload-generate sessions the
  // operator has opened but whose CLI hasn't produced a manifest
  // yet). Without this, an operator who drops product files but is
  // slow to click Generate loses their files to the 30-min retention
  // sweep, and the run fails with ENOENT at generation time.
  protectedRunIds: ReadonlySet<string> = new Set<string>(),
): Promise<SweepResult> {
  const result: SweepResult = {
    scanned: 0,
    evicted: 0,
    imagesOnlyPruned: 0,
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
  const recordCutoffMs = now - cfg.retentionHours * 3600 * 1000;
  const imageCutoffMs = now - cfg.imageRetentionHours * 3600 * 1000;
  const productCutoffMs = now - cfg.productRetentionHours * 3600 * 1000;

  // Two-tier classification per run (entries are newest-first):
  //   recordExpired — beyond the long record window → evict EVERYTHING
  //                   (manifest + csv + html + images). The run is gone.
  //   imageExpired  — within the record window but beyond the tighter
  //                   image window → prune ONLY the images dir. The run
  //                   stays in the list, the CSV stays inspectable; just
  //                   the per-image previews/downloads go.
  const fullEvict: ManifestEntry[] = [];
  const imageOnly: ManifestEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const recordExpired =
      i >= cfg.maxRunsKept ||
      (e.startedAtMs > 0 && e.startedAtMs < recordCutoffMs);
    if (recordExpired) {
      fullEvict.push(e);
      continue;
    }
    const imageExpired =
      i >= cfg.imageMaxRunsKept ||
      (e.startedAtMs > 0 && e.startedAtMs < imageCutoffMs);
    if (imageExpired) imageOnly.push(e);
  }

  // Tier 2 — image-only prune. Keep the run record; drop the heavy dir.
  for (const entry of imageOnly) {
    const runImagesDir = entry.runId ? path.join(outDir, "runs", entry.runId) : null;
    if (!runImagesDir) continue;
    const sz = await dirSize(runImagesDir);
    if (sz === 0) continue; // already pruned on a prior sweep
    await rmrfIfExists(runImagesDir);
    result.bytesFreed += sz;
    result.imagesOnlyPruned++;
  }

  // Tier 1 — full eviction. The run is past the record window entirely.
  for (const entry of fullEvict) {
    const reason: "age" | "count" = "count"; // (kept for reasonByRun shape)
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
  // manifests that still have a record after the full-evict pass.
  // imageOnly runs keep their record, so they are NOT orphans even
  // though their image dir was just pruned.
  const fullyEvicted = new Set(fullEvict.map((e) => e.manifestPath));
  const remainingRunIds = new Set<string>();
  for (const e of entries) {
    if (e.runId && !fullyEvicted.has(e.manifestPath)) {
      remainingRunIds.add(e.runId);
    }
  }
  // Also treat live upload-generate sessions as owned — their
  // products-<runId>/ dir was created before the CLI ran, so it has
  // no manifest yet and would otherwise be swept as orphan (the ENOENT
  // failure mode where the operator drops files, waits >30 min, then
  // hits Generate).
  for (const runId of protectedRunIds) remainingRunIds.add(runId);
  const startedById = new Map<string, number>();
  for (const e of entries) if (e.runId) startedById.set(e.runId, e.startedAtMs);
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

  // ── 2b. Upload-&-Generate sidecar artefacts ───────────────────────
  // The Upload & Generate flow drops three runId-scoped artefacts in
  // outDir:
  //
  //   <outDir>/products-<runId>/         — operator product photos
  //   <outDir>/products-<runId>.json     — manifest of paths/URLs the
  //                                        operator supplied (kept so
  //                                        per-image Regenerate can
  //                                        re-spawn the CLI)
  //   <outDir>/wireframes-<runId>/       — operator-supplied custom
  //                                        wireframes for cover/thumb
  //
  // If the run's manifest is gone (fully evicted, or operator
  // abandoned the modal before /upload-generate/run spawned) all three
  // are unowned and reclaimable. Without this sweep step they pile up
  // forever — products dirs are a few MB each, wireframes are larger,
  // and the .json files are tiny but visible as clutter in /admin/disk.
  try {
    const all = await fs.readdir(outDir, { withFileTypes: true });
    for (const d of all) {
      const dirMatchProducts = d.isDirectory() ? /^products-([a-f0-9]+)$/.exec(d.name) : null;
      const dirMatchWireframes = d.isDirectory() ? /^wireframes-([a-f0-9]+)$/.exec(d.name) : null;
      const fileMatchManifest = d.isFile() ? /^products-([a-f0-9]+)\.json$/.exec(d.name) : null;
      const match = dirMatchProducts ?? dirMatchWireframes ?? fileMatchManifest;
      if (!match) continue;
      const runId = match[1]!;
      // Is this an OWNED run whose product/wireframe DIR has aged out of
      // the image window?
      //
      // These dirs hold image bytes (operator product photos, custom
      // wireframes) but used to be retained on the RECORD window — so
      // raising MAX_RUNS_KEPT / DOWNLOAD_RETENTION_HOURS to keep 30 days
      // of run stats silently kept 30 days of product photos too. The
      // comment above assumed "a few MB each"; on 2026-09-11 they were
      // 131-345 MB each, ~6GB total, and filled the 10GB volume.
      //
      // AGE ONLY, deliberately. Generated images also honour
      // IMAGE_MAX_RUNS_KEPT, but >50 runs happen inside 72h, so the
      // count bound would prune product dirs of runs still inside the
      // product window and break per-image Regenerate on them. Only the
      // age window (cfg.productRetentionHours, 48h) applies here.
      //
      // The tiny products-<runId>.json manifest is NOT pruned here — it
      // stays with the record, which keeps per-image Regenerate working
      // for URL-mode product entries (regenOneHandler re-reads it).
      let imageExpiredDir = false;
      if (remainingRunIds.has(runId)) {
        const started = startedById.get(runId) ?? 0;
        imageExpiredDir = d.isDirectory() && started > 0 && started < productCutoffMs;
        if (!imageExpiredDir) continue;
      }
      const p = path.join(outDir, d.name);
      // Disk-backed proof-of-life sentinel: web.ts writes
      // `products-<runId>/.in-progress` at upload-generate session
      // start, on every product drop, and again at spawn time. If the
      // sentinel exists and is fresh (≤ SESSION_SENTINEL_TTL_MS), the
      // operator hasn't abandoned this session — keep the artefact even
      // though there's no manifest yet. Handles the case where
      // UPGEN_SESSIONS was wiped by a pod restart / browser close
      // mid-session.
      //
      // The sentinel vouches for ALL THREE artefacts of the session,
      // not just the directory it happens to live in. Checking it only
      // for `products-<runId>/` (the previous behaviour) meant a live
      // session could still lose its `wireframes-<runId>/` dir and its
      // `products-<runId>.json` manifest to the sweep — the wireframe
      // loss silently downgrades cover/thumbnail to the default
      // reference, and losing the manifest breaks per-image Regenerate
      // for the rest of that run's life (regenOneHandler reads it to
      // recover the original product entry).
      try {
        const sentinelStat = await fs.stat(
          path.join(outDir, `products-${runId}`, SESSION_SENTINEL_NAME),
        );
        if (Date.now() - sentinelStat.mtimeMs < SESSION_SENTINEL_TTL_MS) continue;
      } catch { /* no sentinel — proceed to evict */ }
      const sz = d.isDirectory() ? await dirSize(p) : await fs.stat(p).then((s) => s.size).catch(() => 0);
      if (d.isDirectory()) await rmrfIfExists(p);
      else await rmIfExists(p);
      if (imageExpiredDir) result.imagesOnlyPruned++;
      else result.orphanRunsDeleted++;
      result.bytesFreed += sz;
    }
  } catch { /* outDir may not exist yet */ }

  // ── 2b'. Leaked read-once temp files ───────────────────────────────
  // The CLI reads --prompt-override-file / --extra-instructions-file /
  // --prompt-per-image-file exactly once, at startup (cli.ts), but for
  // a long time nothing deleted them: 11,488 had accumulated by
  // 2026-09-11. The regenerate job runners now remove them when the
  // child exits; this sweeps the historical backlog and anything a
  // crash leaves behind. 24h, not minutes: a regenerate can sit in the
  // spawn queue before its child starts and reads the file.
  try {
    const tempCutoffMs = now - 24 * 3600 * 1000;
    const all = await fs.readdir(outDir, { withFileTypes: true });
    for (const d of all) {
      if (!d.isFile()) continue;
      if (!/^(prompt-override-.+\.txt|extra-.+\.txt|prompt-per-image-.+\.json)$/.test(d.name)) continue;
      const p = path.join(outDir, d.name);
      const st = await fs.stat(p).catch(() => null);
      if (!st || st.mtimeMs >= tempCutoffMs) continue;
      await rmIfExists(p);
      result.bytesFreed += st.size;
    }
  } catch { /* outDir may not exist yet */ }

  // ── 2b″. Orphaned atomic-write staging files ──────────────────────
  // writeFileAtomic stages every write at
  //   <dir>/.atomic-tmp-<basename>-<pid>-<rand>
  // and renames it into place. That name is deliberately shaped to be
  // invisible to every other filter in this repo (see
  // ATOMIC_TMP_PREFIX) so no reader can ever pick up a half-written
  // file — which also means no other sweep here will collect one. A
  // SIGKILL or a power loss between the write and the rename leaves the
  // staging file behind, and this is the only thing that cleans it up.
  const tmpSwept = await sweepAtomicTmpFiles(outDir, now - ATOMIC_TMP_TTL_MS);
  if (tmpSwept.deleted > 0) {
    result.bytesFreed += tmpSwept.bytes;
    process.stdout.write(
      `retention: swept ${tmpSwept.deleted} orphaned atomic-write staging file(s), ` +
        `${tmpSwept.bytes} bytes\n`,
    );
  }

  // ── 2c. Repoint backups + previews ────────────────────────────────
  // Every apply writes:
  //   <outDir>/repoint-backups/<clusterId>-<stamp>.json
  //   <outDir>/repoint-preview/<clusterId>-<stamp>.json
  //
  // The backup is what `revert.ts` reads to restore a cluster's old
  // page_info — the LATEST per cluster is the only one revert ever
  // uses. Older backups sit as dead weight; each apply mints new
  // ones and none of the old ones ever get read.
  //
  // Previews are the write-time diff snapshot — they're informational
  // only, never read for revert, so their whole population is
  // reclaimable after a short grace window (48h — enough for an
  // operator to inspect the diff after a suspicious apply).
  //
  // Rules:
  //   backups:  keep the newest 1 per cluster; delete all older.
  //   previews: delete anything older than 48h.
  //
  // On a busy deploy this pair combined dwarfs every other artefact
  // (2.3 GB observed on Railway before this sweep landed), so the
  // reclaim is significant.
  const repointBackupsDir = path.join(outDir, "repoint-backups");
  const repointPreviewDir = path.join(outDir, "repoint-preview");
  const PREVIEW_TTL_MS = 48 * 3600 * 1000;
  const nowMs = Date.now();

  // 2c-a: backups — one per cluster, latest wins.
  try {
    const files = await fs.readdir(repointBackupsDir);
    // Group <cid>-<stamp>.json files by cluster_id (uuid prefix).
    const byCluster = new Map<string, Array<{ name: string; mtime: number }>>();
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const m = /^([0-9a-f-]{36})-/.exec(f);
      if (!m) continue;
      const cid = m[1]!;
      const stat = await fs.stat(path.join(repointBackupsDir, f)).catch(() => null);
      if (!stat) continue;
      const arr = byCluster.get(cid) ?? [];
      arr.push({ name: f, mtime: stat.mtimeMs });
      byCluster.set(cid, arr);
    }
    for (const [, arr] of byCluster) {
      // Sort newest first; keep [0], delete [1..].
      arr.sort((a, b) => b.mtime - a.mtime);
      for (let i = 1; i < arr.length; i++) {
        const full = path.join(repointBackupsDir, arr[i]!.name);
        const sz = await fs.stat(full).then((s) => s.size).catch(() => 0);
        await rmIfExists(full);
        result.orphanRunsDeleted++;
        result.bytesFreed += sz;
      }
    }
  } catch { /* dir doesn't exist yet */ }

  // 2c-b: previews — TTL only, no per-cluster retention.
  try {
    const files = await fs.readdir(repointPreviewDir);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const full = path.join(repointPreviewDir, f);
      const stat = await fs.stat(full).catch(() => null);
      if (!stat) continue;
      if (nowMs - stat.mtimeMs < PREVIEW_TTL_MS) continue;
      await rmIfExists(full);
      result.orphanRunsDeleted++;
      result.bytesFreed += stat.size;
    }
  } catch { /* dir doesn't exist yet */ }

  // ── 3. Legacy out/images/<slug>/<file> cleanup ────────────────────
  // Files written by older versions (and any future CLI runs that
  // don't pass --run-id) live here. Build the set of paths currently
  // referenced by any surviving manifest's CSV, then delete any
  // legacy file that ISN'T referenced. This is cheap because each
  // CSV is tiny; we never load image bytes.
  try {
    const refSet = await buildLegacyRefSet(outDir, entries.filter((e) =>
      !fullyEvicted.has(e.manifestPath)));
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
