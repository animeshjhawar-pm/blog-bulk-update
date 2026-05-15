import { promises as fs } from "node:fs";
import path from "node:path";
import { stringify as csvStringify } from "csv-stringify/sync";
import { loadEnv } from "./env.js";
import { closePool, getClusterForApply } from "./db.js";
import { makeLimiter } from "./concurrency.js";

/**
 * Revert flow — restore a cluster's page_info from a repoint backup.
 *
 * `repoint --apply` snapshots the pre-PUT page_info to
 * out/repoint-backups/<clusterId>-<stamp>.json. Revert reads one of
 * those, PUTs it back via the same /file endpoint, and — because a
 * revert is itself a page_info mutation — first snapshots the CURRENT
 * page_info to <clusterId>-prerevert-<stamp>.json so the revert is
 * itself reversible.
 *
 * Same safety contract as repoint: dry-run by default; --apply needed
 * to PUT; token only required for --apply; per-cluster atomic; current
 * state read fresh from the read-only DB (also used to no-op when the
 * cluster already matches the backup).
 */

const DEFAULT_BASE_URL = "https://api.gushwork.ai/seo-v2/project";
export const DEFAULT_BACKUPS_DIR = "out/repoint-backups";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RevertCoreOptions {
  token: string;
  baseUrl?: string;
  apply: boolean;
  concurrency: number;
  failFast: boolean;
  backupsDir?: string;
}

export interface RevertOutcome {
  cluster_id: string;
  project_id: string;
  backup_file: string;
  status: "applied" | "dry-run" | "noop" | "skipped" | "failed";
  reason: string;
  prerevert_snapshot: string;
}

const OUT_HEADER = [
  "cluster_id",
  "project_id",
  "backup_file",
  "status",
  "reason",
  "prerevert_snapshot",
] as const;

interface ParsedName {
  clusterId: string;
  stamp: string;
  isPrerevert: boolean;
}

/** `<uuid>-<stamp>.json` or `<uuid>-prerevert-<stamp>.json`. */
function parseBackupName(file: string): ParsedName | null {
  const base = path.basename(file);
  if (!base.endsWith(".json")) return null;
  const stem = base.slice(0, -5);
  if (stem.length < 37 || stem[36] !== "-") return null;
  const clusterId = stem.slice(0, 36);
  if (!UUID.test(clusterId)) return null;
  let rest = stem.slice(37);
  const isPrerevert = rest.startsWith("prerevert-");
  if (isPrerevert) rest = rest.slice("prerevert-".length);
  return { clusterId, stamp: rest, isPrerevert };
}

/**
 * Newest repoint backup for a cluster (prerevert snapshots excluded).
 * The stamp is an ISO timestamp with `:`/`.` → `-`, so lexicographic
 * sort is chronological.
 */
export async function latestBackupForCluster(
  dir: string,
  clusterId: string,
): Promise<string | null> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return null;
  }
  const cands = names
    .map((n) => ({ n, p: parseBackupName(n) }))
    .filter((x) => x.p && !x.p.isPrerevert && x.p.clusterId === clusterId)
    .sort((a, b) => (a.p!.stamp < b.p!.stamp ? 1 : -1));
  return cands[0] ? path.join(dir, cands[0].n) : null;
}

/** Latest non-prerevert backup for every distinct cluster in `dir`. */
export async function allLatestBackups(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const byCluster = new Map<string, { n: string; stamp: string }>();
  for (const n of names) {
    const p = parseBackupName(n);
    if (!p || p.isPrerevert) continue;
    const cur = byCluster.get(p.clusterId);
    if (!cur || cur.stamp < p.stamp) byCluster.set(p.clusterId, { n, stamp: p.stamp });
  }
  return [...byCluster.values()].map((v) => path.join(dir, v.n));
}

async function revertOne(args: {
  backupFile: string;
  opts: RevertCoreOptions;
  base: string;
  previewDir: string;
}): Promise<RevertOutcome> {
  const { backupFile, opts, base, previewDir } = args;
  const dir = opts.backupsDir ?? DEFAULT_BACKUPS_DIR;
  const parsed = parseBackupName(backupFile);
  const out: RevertOutcome = {
    cluster_id: parsed?.clusterId ?? "",
    project_id: "",
    backup_file: backupFile,
    status: "failed",
    reason: "",
    prerevert_snapshot: "",
  };
  if (!parsed) {
    out.reason = `not a recognisable backup filename (expected <uuid>-<stamp>.json): ${path.basename(backupFile)}`;
    return out;
  }
  if (parsed.isPrerevert) {
    out.reason = "refusing to revert FROM a prerevert snapshot — pass the original repoint backup";
    return out;
  }
  const clusterId = parsed.clusterId;

  let backupPi: unknown;
  try {
    backupPi = JSON.parse(await fs.readFile(backupFile, "utf8"));
  } catch (e) {
    out.reason = `cannot read/parse backup: ${(e as Error).message}`;
    return out;
  }
  if (!backupPi || typeof backupPi !== "object" || Array.isArray(backupPi)) {
    out.reason = "backup JSON is not a page_info object";
    return out;
  }

  const cluster = await getClusterForApply(clusterId);
  if (!cluster || !cluster.page_info) {
    out.reason = `cluster ${clusterId} not found / no page_info in DB`;
    return out;
  }
  out.project_id = cluster.p_id;

  const currentStr = JSON.stringify(cluster.page_info);
  const backupStr = JSON.stringify(backupPi);
  if (currentStr === backupStr) {
    out.status = "noop";
    out.reason = "current page_info already matches the backup — nothing to revert";
    return out;
  }

  // Snapshot CURRENT before touching anything (revert is reversible).
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const snap = path.join(dir, `${clusterId}-prerevert-${stamp}.json`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(snap, JSON.stringify(cluster.page_info, null, 2), "utf8");
    out.prerevert_snapshot = snap;
  } catch (e) {
    out.reason = `failed to write pre-revert snapshot, aborting: ${(e as Error).message}`;
    return out;
  }

  if (!opts.apply) {
    const preview = path.join(previewDir, `${clusterId}-${stamp}.json`);
    await fs.mkdir(previewDir, { recursive: true });
    await fs.writeFile(preview, JSON.stringify(backupPi, null, 2), "utf8");
    out.status = "dry-run";
    out.reason = `would restore ${path.basename(backupFile)} (current snapshotted to ${path.basename(snap)})`;
    return out;
  }

  try {
    const resp = await fetch(`${base}/${cluster.p_id}/file`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        file_id: clusterId,
        type: "PAGE",
        file_type: "page_info",
        file_content: backupPi,
      }),
    });
    if (!resp.ok) {
      out.reason = `PUT /file HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`;
      return out;
    }
    out.status = "applied";
    out.reason = `restored ${path.basename(backupFile)} (pre-revert snapshot: ${path.basename(snap)})`;
    return out;
  } catch (err) {
    out.reason = `PUT failed: ${err instanceof Error ? err.message : String(err)}`;
    return out;
  }
}

export async function revertBackups(
  backupFiles: string[],
  opts: RevertCoreOptions,
): Promise<{ outcomes: RevertOutcome[]; aborted: Error | null }> {
  const base = opts.baseUrl ?? DEFAULT_BASE_URL;
  const previewDir = path.resolve(process.cwd(), "out", "revert-preview");
  const limit = makeLimiter(opts.concurrency);
  const outcomes: RevertOutcome[] = [];
  const abortBox: { err: Error | null } = { err: null };

  await Promise.all(
    backupFiles.map((backupFile) =>
      limit(async () => {
        if (abortBox.err) return;
        try {
          const oc = await revertOne({ backupFile, opts, base, previewDir });
          outcomes.push(oc);
          if (opts.failFast && (oc.status === "failed" || oc.status === "skipped")) {
            abortBox.err = new Error(`${path.basename(backupFile)}: ${oc.reason}`);
          }
        } catch (err) {
          abortBox.err = err instanceof Error ? err : new Error(String(err));
        }
      }),
    ),
  );
  return { outcomes, aborted: abortBox.err };
}

export interface RevertCliOptions extends RevertCoreOptions {
  /** Exactly one of these selects the target set. */
  file?: string;
  cluster?: string;
  all?: boolean;
  outPath?: string;
}

export async function runRevert(opts: RevertCliOptions): Promise<void> {
  loadEnv();
  const dir = opts.backupsDir ?? DEFAULT_BACKUPS_DIR;

  let files: string[] = [];
  if (opts.file) {
    files = [path.resolve(opts.file)];
  } else if (opts.cluster) {
    const f = await latestBackupForCluster(dir, opts.cluster);
    if (!f) {
      process.stderr.write(`revert: no backup found for cluster ${opts.cluster} in ${dir}\n`);
      await closePool();
      return;
    }
    files = [f];
  } else if (opts.all) {
    files = await allLatestBackups(dir);
  } else {
    process.stderr.write("revert: pass one of --file <path> | --cluster <id> | --all\n");
    await closePool();
    process.exitCode = 2;
    return;
  }

  if (files.length === 0) {
    process.stderr.write(`revert: nothing to revert (no backups in ${dir})\n`);
    await closePool();
    return;
  }

  process.stderr.write(
    `revert: ${files.length} backup(s) — mode=${opts.apply ? "APPLY (will PUT prior page_info)" : "DRY-RUN (no writes)"}\n`,
  );

  const { outcomes, aborted } = await revertBackups(files, opts);

  const outPath =
    opts.outPath ??
    path.resolve(
      process.cwd(),
      "out",
      `revert-${opts.apply ? "applied" : "dryrun"}-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`,
    );
  await fs.writeFile(outPath, csvStringify(outcomes, { header: true, columns: [...OUT_HEADER] }), "utf8");

  const tally = (s: string) => outcomes.filter((o) => o.status === s).length;
  await closePool();
  process.stderr.write(
    `revert: done — applied=${tally("applied")} dry-run=${tally("dry-run")} ` +
      `noop=${tally("noop")} failed=${tally("failed")}\n` +
      `revert: report = ${outPath}\n`,
  );
  if (aborted) {
    process.stderr.write(`revert: ABORTED (--fail-fast) — ${aborted.message}\n`);
    process.exitCode = 1;
  }
}
