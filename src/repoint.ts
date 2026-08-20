import { promises as fs } from "node:fs";
import path from "node:path";
import { runOutDir } from "./runOutDir.js";
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
  // "superseded" — the old image_id is no longer in the live
  // page_info, which means an earlier apply already replaced it (or
  // the page was re-rendered upstream). NOT a failure: the slot is
  // already updated, there is simply nothing left to do.
  status: "applied" | "dry-run" | "skipped" | "failed" | "superseded";
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

  // Gate 2: every `old` must be present in the current page_info.
  // If an `old` is absent there are TWO distinct cases — and they
  // must NOT be conflated (doing so paints a genuine failure as a
  // green "already applied" card, masking that nothing happened):
  //
  //  (a) The matching `new` id IS present. A previous apply of THIS
  //      mapping already swapped old→new. Genuinely idempotent —
  //      "superseded": nothing to do, the live page is updated.
  //
  //  (b) Neither old nor new is present. The recorded image_id no
  //      longer matches the live page_info at all — the page was
  //      re-rendered upstream, or the run is stale. This is a REAL
  //      FAILURE: the operator's replacement will NOT go live and
  //      they must be told so, loudly.
  for (const p of pairs) {
    if (!original.includes(p.old)) {
      if (p.old !== p.neu && original.includes(p.neu)) {
        out.status = "superseded";
        out.reason = `image_id ${p.old.slice(0, 60)} was already replaced by ${p.neu.slice(0, 60)} in the live page_info — already applied. Nothing to do.`;
      } else {
        out.status = "failed";
        out.reason = `image_id ${p.old.slice(0, 60)} is NOT in the live page_info, and neither is the intended replacement — the recorded mapping is stale (the page was re-rendered upstream, or this run's image_id no longer matches live page_info). Nothing was written; re-import the cluster and create a fresh run.`;
      }
      process.stderr.write(
        `[${out.status}] cluster=${clusterId} client=${clientSlug} :: ${out.reason}\n`,
      );
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

  // --apply: persist the new page_info, then PROVE it took.
  //
  // History: the only writer used to be the seo-v2 `/file` PUT. It
  // was observed to return HTTP 200 while NOT persisting for some
  // service pages — the handler trusted the status code, marked the
  // cluster "applied", and the operator's replacement silently never
  // went live. So the contract is now: write, then re-read the live
  // page_info from the DB and verify the swap is actually there. A
  // cluster is "applied" ONLY if that read-back proves it.
  //
  // Writer: `/file` PUT only. It is the platform publish surface and
  // the only path allowed to mutate page_info from this tool.
  // Verify with a short retry window — Gushwork's write to the
  // stormbreaker DB isn't always synchronous with the PUT response.
  // Ops saw "8 of 10 apply, 2 miss" where the PUT returned 200 but
  // the immediate re-read of page_info didn't have our new UUIDs.
  // Waiting up to 6s (12 × 500ms) with an eager first attempt bridges
  // the gap without slowing the happy path.
  const verifyApplied = async (): Promise<boolean> => {
    const VERIFY_MAX_ATTEMPTS = 12;
    const VERIFY_INTERVAL_MS = 500;
    for (let attempt = 1; attempt <= VERIFY_MAX_ATTEMPTS; attempt++) {
      const fresh = await getClusterForApply(clusterId);
      if (fresh?.page_info) {
        const live = JSON.stringify(fresh.page_info);
        let allPresent = true;
        for (const p of pairs) {
          if (p.old !== p.neu && live.includes(p.old)) { allPresent = false; break; }
          if (!live.includes(p.neu)) { allPresent = false; break; }
        }
        if (allPresent) return true;
      }
      if (attempt < VERIFY_MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, VERIFY_INTERVAL_MS));
      }
    }
    return false;
  };

  // PUT with timeout + retry on transient network / 5xx errors.
  // Previously: unbounded default fetch timeout + zero retries; one
  // hiccup and the cluster was marked failed even though a second
  // attempt would have succeeded. Now: 30s per attempt, 3 tries with
  // 1s/2s/4s backoff, only retrying on network errors + 5xx (4xx auth
  // / validation errors stop immediately — retrying them doesn't help).
  const PUT_MAX_ATTEMPTS = 3;
  const PUT_TIMEOUT_MS = 30_000;
  const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
  let putNote = "";
  let putSucceeded = false;
  for (let attempt = 1; attempt <= PUT_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), PUT_TIMEOUT_MS);
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
        signal: controller.signal,
      });
      const bodyText = (await resp.text()).slice(0, 300);
      putNote = `PUT /file HTTP ${resp.status}${bodyText ? ` ${bodyText}` : ""}${attempt > 1 ? ` (attempt ${attempt}/${PUT_MAX_ATTEMPTS})` : ""}`;
      if (resp.ok) { putSucceeded = true; break; }
      // 4xx (auth, validation) never retry — burning attempts on a
      // client error just delays the operator's actual fix.
      if (!RETRYABLE_STATUS.has(resp.status)) break;
      if (attempt < PUT_MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt - 1) * 1000));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      putNote = `PUT /file threw: ${msg} (attempt ${attempt}/${PUT_MAX_ATTEMPTS})`;
      if (attempt < PUT_MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt - 1) * 1000));
      }
    } finally {
      clearTimeout(to);
    }
  }

  // Even when PUT returned a non-2xx, verify anyway — Gushwork
  // occasionally returns 500 with the write actually persisted.
  // The DB is the source of truth; if it has our UUIDs, we're good.
  if (await verifyApplied()) {
    out.status = "applied";
    out.reason = `applied via /file PUT — ${out.replacements} occurrence(s) repointed: ${perPair}`;
    process.stderr.write(
      `[applied] cluster=${clusterId} client=${clientSlug} repl=${out.replacements} (${putNote})\n`,
    );
    return out;
  }

  out.reason =
    `page_info write did not verify after ${putNote}. ` +
    `Verified across ${putSucceeded ? "1" : PUT_MAX_ATTEMPTS} PUT attempt(s) + 12 read-back tries over 6s. ` +
    `No direct DB fallback attempted; /file is the only allowed publish path. ` +
    `Nothing reliable can be reported as applied.`;
  process.stderr.write(`[failed] cluster=${clusterId} client=${clientSlug} :: ${out.reason}\n`);
  return out;
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

  const outDir = runOutDir();
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
          let oc = await repointCluster({
            clusterId,
            rows,
            opts: { ...opts, csvPath: "", apply: opts.apply },
            base,
            backupDir,
            previewDir,
          });
          // Cluster-level auto-retry — one more shot after 30s if the
          // cluster failed. Complementary to the PUT-attempt retry
          // (per-attempt) and verify-backoff (per-cluster read window)
          // that already live in repointCluster: THIS retry catches
          // the "everything above genuinely gave up, but the next
          // attempt 30s later succeeds" case (Gushwork briefly slow,
          // stormbreaker DB replication catching up, network blip
          // outside all inner retry windows). Skipped for non-apply
          // (dry-run) and non-failed outcomes.
          if (opts.apply && oc.status === "failed") {
            process.stderr.write(
              `[retry] cluster=${clusterId} :: cluster-level auto-retry after 30s (previous: ${oc.reason.slice(0, 120)})\n`,
            );
            await new Promise((r) => setTimeout(r, 30_000));
            try {
              const oc2 = await repointCluster({
                clusterId,
                rows,
                opts: { ...opts, csvPath: "", apply: opts.apply },
                base,
                backupDir,
                previewDir,
              });
              if (oc2.status === "applied" || oc2.status === "superseded") {
                oc = oc2;
                process.stderr.write(
                  `[retry-recovered] cluster=${clusterId} :: cluster-level retry succeeded\n`,
                );
              } else {
                oc = oc2;
                process.stderr.write(
                  `[retry-failed] cluster=${clusterId} :: ${oc2.reason.slice(0, 200)}\n`,
                );
              }
            } catch (retryErr) {
              process.stderr.write(
                `[retry-crashed] cluster=${clusterId} :: ${(retryErr as Error).message}\n`,
              );
            }
          }
          outcomes.push(oc);
          // Log every non-applied/non-dry-run outcome — those paths
          // (gate 1 skip, cluster-not-found, project mismatch) were
          // previously silent, so a skipped cluster left no trace in
          // the Railway logs to diagnose from.
          if (oc.status !== "applied" && oc.status !== "dry-run") {
            process.stderr.write(`[${oc.status}] cluster=${clusterId} :: ${oc.reason}\n`);
          }
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
      `superseded=${tally("superseded")} skipped=${tally("skipped")} failed=${tally("failed")}\n` +
      `repoint: report = ${outPath}\n` +
      `repoint: backups = ${backupDir}\n`,
  );
  if (aborted) {
    process.stderr.write(`repoint: ABORTED (--fail-fast) — ${aborted.message}\n`);
    process.exitCode = 1;
  }
}
