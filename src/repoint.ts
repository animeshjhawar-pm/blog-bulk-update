import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as csvParse } from "csv-parse/sync";
import { stringify as csvStringify } from "csv-stringify/sync";
import { loadEnv } from "./env.js";
import { closePool, getClusterForApply } from "./db.js";
import { makeLimiter } from "./concurrency.js";

/**
 * Per-cluster page_info repoint.
 *
 * Consumes the mapping CSV emitted by `upload` (old_image_id ->
 * new_image_id / new_cdn_url_*), and rewrites each cluster's page_info
 * so it references the NEW images.
 *
 * Mechanism (see the DB investigation): a blog image UUID appears in
 * BOTH blog_text.md and blog_text.interlinked_md; the thumbnail URL is
 * echoed inside the stringified meta.schema_markup. Structurally
 * navigating each is fragile, so we do an exact-string replace over
 * the SERIALIZED page_info JSON (UUIDs and full CDN URLs are
 * collision-safe substrings) and re-parse to prove we didn't corrupt
 * it. That single operation covers .md, .interlinked_md, and the
 * nested escaped schema_markup at once.
 *
 * Safety contract:
 *  - A cluster is repointed only if EVERY one of its mapping rows is
 *    upload_status === "uploaded" (decision: skip-whole-cluster).
 *  - Current page_info is read fresh from the read-only DB right
 *    before the write (decision: read-only DB).
 *  - Dry-run by default; --apply is required to PUT (decision).
 *  - Original page_info is snapshotted to disk before any PUT.
 *  - Per-cluster atomic: one PUT with the full new page_info, or none.
 */

const DEFAULT_BASE_URL = "https://api.gushwork.ai/seo-v2/project";

export interface RepointOptions {
  /** Upload mapping CSV (output of the `upload` command). */
  csvPath: string;
  token: string;
  baseUrl?: string;
  /** When false (default) nothing is PUT — preview + backup only. */
  apply: boolean;
  concurrency: number;
  failFast: boolean;
  outPath?: string;
}

export interface MapRow {
  old_image_id: string;
  asset_type: string;
  cluster_id: string;
  client_slug: string;
  project_id: string;
  page_topic: string;
  new_image_id: string;
  new_refined_key: string;
  new_cdn_url_1080: string;
  new_cdn_url_720: string;
  new_cdn_url_360: string;
  new_cdn_url_default: string;
  upload_status: string;
}

export interface ClusterOutcome {
  cluster_id: string;
  project_id: string;
  client_slug: string;
  images: number;
  status: "applied" | "dry-run" | "skipped" | "failed";
  reason: string;
  replacements: number;
  backup_path: string;
  preview_path: string;
}

const OUT_HEADER = [
  "cluster_id",
  "project_id",
  "client_slug",
  "images",
  "status",
  "reason",
  "replacements",
  "backup_path",
  "preview_path",
] as const;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace every `old` with its `new` in one pass over `text`. Matching
 * is done against the ORIGINAL text only (regex alternation), so a
 * replacement value can never be re-matched as another pair's `old`.
 * Longest `old` first guards against one identifier being a prefix of
 * another. Returns the new text + per-old replacement counts.
 */
function applyReplacements(
  text: string,
  pairs: Array<{ old: string; neu: string }>,
): { out: string; counts: Map<string, number> } {
  const counts = new Map<string, number>(pairs.map((p) => [p.old, 0]));
  const sorted = [...pairs].sort((a, b) => b.old.length - a.old.length);
  const lookup = new Map(sorted.map((p) => [p.old, p.neu]));
  const re = new RegExp(sorted.map((p) => escapeRe(p.old)).join("|"), "g");
  const out = text.replace(re, (m) => {
    counts.set(m, (counts.get(m) ?? 0) + 1);
    return lookup.get(m) ?? m;
  });
  return { out, counts };
}

function thumbnailString(pi: Record<string, unknown>): string | null {
  const t = pi.thumbnail;
  if (typeof t === "string" && t.length > 0) return t;
  if (t && typeof t === "object") {
    const u = (t as { url?: unknown }).url;
    if (typeof u === "string" && u.length > 0) return u;
  }
  return null;
}

async function repointCluster(args: {
  clusterId: string;
  rows: MapRow[];
  opts: RepointOptions;
  base: string;
  backupDir: string;
  previewDir: string;
}): Promise<ClusterOutcome> {
  const { clusterId, rows, opts, base, backupDir, previewDir } = args;
  const projectId = rows[0]!.project_id;
  const clientSlug = rows[0]!.client_slug;
  const out: ClusterOutcome = {
    cluster_id: clusterId,
    project_id: projectId,
    client_slug: clientSlug,
    images: rows.length,
    status: "failed",
    reason: "",
    replacements: 0,
    backup_path: "",
    preview_path: "",
  };

  // Gate 1: skip the whole cluster unless every image uploaded cleanly.
  const notReady = rows.filter((r) => r.upload_status !== "uploaded");
  if (notReady.length > 0) {
    out.status = "skipped";
    out.reason = `${notReady.length}/${rows.length} image(s) not 'uploaded' (${[
      ...new Set(notReady.map((r) => r.upload_status || "?")),
    ].join(",")}) — skip-whole-cluster`;
    return out;
  }

  // Fresh current page_info from the read-only DB.
  const cluster = await getClusterForApply(clusterId);
  if (!cluster || !cluster.page_info) {
    out.reason = `cluster ${clusterId} not found / no page_info in DB`;
    return out;
  }
  if (cluster.p_id !== projectId) {
    out.reason = `project mismatch: CSV says ${projectId}, DB cluster.p_id=${cluster.p_id}`;
    return out;
  }

  const original = JSON.stringify(cluster.page_info);

  // Build replacement pairs.
  const pairs: Array<{ old: string; neu: string }> = [];
  for (const r of rows) {
    const isThumb = r.asset_type === "thumbnail";
    if (isThumb) {
      const cur = thumbnailString(cluster.page_info);
      if (!cur) {
        out.reason = `thumbnail row but page_info has no thumbnail string`;
        return out;
      }
      if (!r.new_cdn_url_1080) {
        out.reason = `thumbnail row missing new_cdn_url_1080 in mapping CSV`;
        return out;
      }
      pairs.push({ old: cur, neu: r.new_cdn_url_1080 });
    } else {
      if (!r.old_image_id || !r.new_image_id) {
        out.reason = `row missing old/new image_id (asset=${r.asset_type})`;
        return out;
      }
      pairs.push({ old: r.old_image_id, neu: r.new_image_id });
    }
  }

  // Gate 2: every `old` must be present in the current page_info,
  // else the mapping is stale or the cluster changed underneath us.
  for (const p of pairs) {
    if (!original.includes(p.old)) {
      out.reason = `expected identifier not found in current page_info: ${p.old.slice(0, 60)} — mapping stale, not writing`;
      return out;
    }
  }

  const { out: rewritten, counts } = applyReplacements(original, pairs);
  out.replacements = [...counts.values()].reduce((a, b) => a + b, 0);

  // Gate 3: result must still be valid JSON.
  let reparsed: unknown;
  try {
    reparsed = JSON.parse(rewritten);
  } catch (e) {
    out.reason = `rewrite produced invalid JSON: ${(e as Error).message}`;
    return out;
  }

  // Gate 4: no targeted `old` may survive, and every `new` must now
  // be present. (Thumbnail `old` is a full URL; once swapped it must
  // be gone.)
  const after = JSON.stringify(reparsed);
  for (const p of pairs) {
    if (after.includes(p.old) && p.old !== p.neu) {
      out.reason = `post-rewrite still contains old id ${p.old.slice(0, 60)} (count anomaly)`;
      return out;
    }
    if (!after.includes(p.neu)) {
      out.reason = `post-rewrite missing new value ${p.neu.slice(0, 60)}`;
      return out;
    }
  }

  // Snapshot original + preview new — always, even in dry-run.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  out.backup_path = path.join(backupDir, `${clusterId}-${stamp}.json`);
  out.preview_path = path.join(previewDir, `${clusterId}-${stamp}.json`);
  await fs.writeFile(out.backup_path, JSON.stringify(cluster.page_info, null, 2), "utf8");
  await fs.writeFile(out.preview_path, JSON.stringify(reparsed, null, 2), "utf8");

  const perPair = pairs
    .map((p) => `${p.old.slice(0, 12)}…→${p.neu.slice(0, 12)}…×${counts.get(p.old) ?? 0}`)
    .join("  ");

  if (!opts.apply) {
    out.status = "dry-run";
    out.reason = `would replace ${out.replacements} occurrence(s): ${perPair}`;
    process.stderr.write(
      `[dry-run] cluster=${clusterId} client=${clientSlug} images=${rows.length} repl=${out.replacements} :: ${perPair}\n`,
    );
    return out;
  }

  // --apply: one atomic PUT of the full new page_info.
  try {
    const resp = await fetch(`${base}/${projectId}/file`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        file_id: clusterId,
        type: "PAGE",
        file_type: "page_info",
        file_content: reparsed,
      }),
    });
    if (!resp.ok) {
      out.reason = `PUT /file HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`;
      return out;
    }
    out.status = "applied";
    out.reason = `PUT ok — ${out.replacements} occurrence(s) repointed: ${perPair}`;
    process.stderr.write(
      `[applied] cluster=${clusterId} client=${clientSlug} repl=${out.replacements}\n`,
    );
    return out;
  } catch (err) {
    out.reason = `PUT failed: ${err instanceof Error ? err.message : String(err)}`;
    return out;
  }
}

export interface RepointCoreOptions {
  token: string;
  baseUrl?: string;
  apply: boolean;
  concurrency: number;
  failFast: boolean;
}

/**
 * In-memory core: group already-parsed mapping rows by cluster and
 * repoint each. Backups + previews are still written to out/ (the
 * revert flow needs them even when driven from the web UI). Returns
 * outcomes; no CSV/pool side effects — the CLI wrapper and the web
 * handler both build on this.
 */
export async function repointMappingRows(
  mapRows: MapRow[],
  opts: RepointCoreOptions,
): Promise<{ outcomes: ClusterOutcome[]; aborted: Error | null; backupDir: string }> {
  const base = opts.baseUrl ?? DEFAULT_BASE_URL;
  const byCluster = new Map<string, MapRow[]>();
  for (const r of mapRows) {
    if (!r.cluster_id) continue;
    let arr = byCluster.get(r.cluster_id);
    if (!arr) {
      arr = [];
      byCluster.set(r.cluster_id, arr);
    }
    arr.push(r);
  }

  const outDir = path.resolve(process.cwd(), "out");
  const backupDir = path.join(outDir, "repoint-backups");
  const previewDir = path.join(outDir, "repoint-preview");
  await fs.mkdir(backupDir, { recursive: true });
  await fs.mkdir(previewDir, { recursive: true });

  const limit = makeLimiter(opts.concurrency);
  const outcomes: ClusterOutcome[] = [];
  const abortBox: { err: Error | null } = { err: null };

  await Promise.all(
    [...byCluster.entries()].map(([clusterId, rows]) =>
      limit(async () => {
        if (abortBox.err) return;
        try {
          const oc = await repointCluster({
            clusterId,
            rows,
            opts: { ...opts, csvPath: "", apply: opts.apply },
            base,
            backupDir,
            previewDir,
          });
          outcomes.push(oc);
          if (opts.failFast && (oc.status === "failed" || oc.status === "skipped")) {
            abortBox.err = new Error(`cluster ${clusterId}: ${oc.reason}`);
          }
        } catch (err) {
          abortBox.err = err instanceof Error ? err : new Error(String(err));
        }
      }),
    ),
  );

  return { outcomes, aborted: abortBox.err, backupDir };
}

export async function runRepoint(opts: RepointOptions): Promise<void> {
  loadEnv(); // DATABASE_URL for the read-only page_info fetch

  const raw = await fs.readFile(opts.csvPath, "utf8");
  const mapRows = csvParse(raw, { columns: true, skip_empty_lines: true }) as MapRow[];
  if (mapRows.length === 0) {
    process.stderr.write("repoint: mapping CSV is empty\n");
    await closePool();
    return;
  }

  process.stderr.write(
    `repoint: ${mapRows.length} mapping rows — ` +
      `mode=${opts.apply ? "APPLY (will mutate page_info)" : "DRY-RUN (no writes)"}\n`,
  );

  const { outcomes, aborted, backupDir } = await repointMappingRows(mapRows, {
    token: opts.token,
    baseUrl: opts.baseUrl,
    apply: opts.apply,
    concurrency: opts.concurrency,
    failFast: opts.failFast,
  });

  const outPath =
    opts.outPath ??
    opts.csvPath.replace(/\.csv$/i, "") +
      `-repoint-${opts.apply ? "applied" : "dryrun"}-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  await fs.writeFile(
    outPath,
    csvStringify(outcomes, { header: true, columns: [...OUT_HEADER] }),
    "utf8",
  );

  const tally = (s: string) => outcomes.filter((o) => o.status === s).length;
  await closePool();
  process.stderr.write(
    `repoint: done — applied=${tally("applied")} dry-run=${tally("dry-run")} ` +
      `skipped=${tally("skipped")} failed=${tally("failed")}\n` +
      `repoint: report = ${outPath}\n` +
      `repoint: backups = ${backupDir}\n`,
  );
  if (aborted) {
    process.stderr.write(`repoint: ABORTED (--fail-fast) — ${aborted.message}\n`);
    process.exitCode = 1;
  }
}
