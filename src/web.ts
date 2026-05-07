import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CLIENTS, findClient } from "./clients.js";
import {
  closePool,
  listPublishedBlogClusters,
  lookupProjectById,
  type ClusterRow,
  type ProjectRow,
} from "./db.js";
import { collectImageRecords, type AssetType } from "./pageInfo.js";
import { loadEnv } from "./env.js";

const LOGO_URL = "https://cdn.gushwork.ai/v2/gush_new_logo.svg";
const APP_TITLE = "Blog Image Update";

interface RunState {
  id: string;
  client: string;
  args: string[];
  startedAt: string;
  log: string[];
  done: boolean;
  exitCode: number | null;
  csvPath?: string;
  htmlPath?: string;
  proc: ChildProcess;
  listeners: Set<ServerResponse>;
}

const RUNS = new Map<string, RunState>();

// ────────────────────────────────────────────────────────────────────────
// HTML helpers
// ────────────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function shell(title: string, body: string, scripts = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(APP_TITLE)}</title>
<link rel="icon" type="image/svg+xml" href="${esc(LOGO_URL)}">
<style>
  :root {
    --bg: #f6f7f9;
    --card: #ffffff;
    --border: #e4e7ec;
    --border-strong: #d0d5dd;
    --ink: #0f172a;
    --ink-muted: #64748b;
    --ink-faint: #94a3b8;
    --brand: #4338ca;
    --brand-hover: #3730a3;
    --accent-bg: #eef2ff;
    --ok: #047857;
    --ok-bg: #d1fae5;
    --warn: #b45309;
    --warn-bg: #fef3c7;
    --err: #b91c1c;
    --err-bg: #fee2e2;
    --shadow: 0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.04);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font: 14px/1.5 -apple-system, "Inter", system-ui, "Segoe UI", sans-serif;
    color: var(--ink);
    background: var(--bg);
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
  }
  a { color: var(--brand); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { font: 12px ui-monospace, "JetBrains Mono", Menlo, monospace; background: #f1f5f9; padding: 2px 6px; border-radius: 4px; color: #334155; word-break: break-all; }
  header.app {
    background: #fff;
    border-bottom: 1px solid var(--border);
    padding: 14px 24px;
    display: flex;
    align-items: center;
    gap: 16px;
    position: sticky;
    top: 0;
    z-index: 10;
  }
  header.app img.logo { height: 24px; display: block; }
  header.app .title { font-size: 15px; font-weight: 600; letter-spacing: -.01em; }
  header.app .crumb { color: var(--ink-faint); font-weight: 400; margin-left: 4px; }
  header.app nav { margin-left: auto; display: flex; gap: 18px; font-size: 13px; }
  header.app nav a { color: var(--ink-muted); }
  header.app nav a:hover { color: var(--ink); text-decoration: none; }

  main { max-width: 1180px; margin: 0 auto; padding: 24px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow); padding: 20px; margin-bottom: 16px; }
  .card h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-muted); margin: 0 0 12px; font-weight: 600; }
  .card h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: -.01em; }
  .card .sub { color: var(--ink-muted); font-size: 13px; }

  /* Forms / inputs */
  label { display: block; font-size: 12px; color: var(--ink-muted); margin-bottom: 4px; font-weight: 500; }
  input[type="text"], input[type="number"], select, input[type="file"] {
    font: inherit; padding: 8px 10px;
    border: 1px solid var(--border-strong); border-radius: 6px;
    background: #fff; color: var(--ink);
    width: 100%;
  }
  input[type="text"]:focus, select:focus, input[type="number"]:focus { outline: 2px solid var(--accent-bg); border-color: var(--brand); }
  input[type="checkbox"] { accent-color: var(--brand); width: 16px; height: 16px; cursor: pointer; }
  .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: end; }
  .row > * { flex: 1; min-width: 160px; }
  .check-row { display: flex; align-items: center; gap: 8px; font-size: 13px; }
  .check-row label { display: inline; margin: 0; color: var(--ink); font-weight: 400; cursor: pointer; }

  button, .btn {
    font: inherit; font-weight: 500;
    padding: 8px 16px; border: 1px solid var(--border-strong); border-radius: 6px;
    background: #fff; color: var(--ink); cursor: pointer;
    transition: background .12s, border-color .12s;
  }
  button:hover, .btn:hover { background: #f9fafb; }
  button.primary, .btn.primary {
    background: var(--brand); color: #fff; border-color: var(--brand);
  }
  button.primary:hover, .btn.primary:hover { background: var(--brand-hover); border-color: var(--brand-hover); }
  button.primary:disabled { background: #cbd5e1; border-color: #cbd5e1; cursor: not-allowed; }

  /* Tables */
  table { width: 100%; border-collapse: collapse; }
  table.cluster-list th, table.cluster-list td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--border); font-size: 13px; vertical-align: top; }
  table.cluster-list th { background: #f8fafc; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-muted); position: sticky; top: 56px; z-index: 5; }
  table.cluster-list tr.row-hidden { display: none; }
  table.cluster-list tr.row-matched { background: #fefce8; }
  table.cluster-list tr:hover { background: #f8fafc; }
  table.cluster-list td.topic { font-weight: 500; max-width: 480px; }
  table.cluster-list td.cid code { font-size: 11px; }

  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 500; }
  .pill.cover { background: #dbeafe; color: #1e40af; }
  .pill.thumbnail { background: #ede9fe; color: #5b21b6; }
  .pill.infographic { background: #fef3c7; color: #92400e; }
  .pill.internal { background: #d1fae5; color: #065f46; }
  .pill.external { background: #fce7f3; color: #9d174d; }
  .pill.generic { background: #e5e7eb; color: #374151; }

  .toolbar { display: flex; gap: 12px; align-items: center; padding: 12px 0; border-bottom: 1px solid var(--border); margin-bottom: 0; flex-wrap: wrap; }
  .toolbar .grow { flex: 1; min-width: 200px; }
  .toolbar .selected-count { font-size: 13px; color: var(--ink-muted); }
  .toolbar .selected-count strong { color: var(--ink); }

  .banner { padding: 12px 14px; border-radius: 8px; margin-bottom: 12px; font-size: 13px; }
  .banner.err { background: var(--err-bg); color: var(--err); border: 1px solid #fca5a5; }
  .banner.ok { background: var(--ok-bg); color: var(--ok); border: 1px solid #86efac; }
  .banner.warn { background: var(--warn-bg); color: var(--warn); border: 1px solid #fde68a; }
  .banner.info { background: var(--accent-bg); color: var(--brand); border: 1px solid #c7d2fe; }

  .help { font-size: 12px; color: var(--ink-muted); line-height: 1.5; }
  .help code { font-size: 11px; background: #f1f5f9; }
  .help ul { margin: 6px 0 0; padding-left: 18px; }
  .help li { margin-bottom: 2px; }

  .log { background: #0f172a; color: #e2e8f0; padding: 14px 16px; border-radius: 8px; font: 12px/1.55 ui-monospace, "JetBrains Mono", Menlo, monospace; white-space: pre-wrap; max-height: 60vh; overflow: auto; }
  .log .stamp { color: #64748b; }

  .sticky-actions {
    position: sticky; bottom: 0; background: rgba(255,255,255,.96); backdrop-filter: blur(6px);
    border-top: 1px solid var(--border); padding: 14px 0; margin-top: 12px;
    display: flex; gap: 12px; align-items: center; justify-content: flex-end;
  }
  .sticky-actions .meta { color: var(--ink-muted); font-size: 13px; margin-right: auto; }

  details > summary { cursor: pointer; user-select: none; }
  details[open] > summary { margin-bottom: 8px; }
  fieldset { border: none; padding: 0; margin: 0; }
</style>
</head>
<body>
<header class="app">
  <img class="logo" src="${esc(LOGO_URL)}" alt="Gushwork">
  <span class="title">${esc(APP_TITLE)}</span>
  <nav>
    <a href="/">Home</a>
    <a href="/runs">Runs</a>
  </nav>
</header>
<main>
${body}
</main>
${scripts}
</body>
</html>`;
}

function send(res: ServerResponse, status: number, ctype: string, body: string) {
  res.writeHead(status, { "content-type": ctype });
  res.end(body);
}

function sendHtml(res: ServerResponse, status: number, body: string) {
  send(res, status, "text/html; charset=utf-8", body);
}

// ────────────────────────────────────────────────────────────────────────
// Routes
// ────────────────────────────────────────────────────────────────────────

function homePage(res: ServerResponse) {
  const opts = CLIENTS.map(
    (c) => `<option value="${esc(c.slug)}">${esc(c.slug)}</option>`,
  ).join("");

  sendHtml(res, 200, shell("Home", `
<section class="card">
  <h1>${esc(APP_TITLE)}</h1>
  <div class="sub">Bulk-regenerate cover, thumbnail, and inline images for published blog pages in <code>gw_stormbreaker</code>.</div>
</section>

<section class="card">
  <h2>Pick a client</h2>
  <form method="get" action="/clusters">
    <div class="row">
      <div style="flex:2">
        <label for="client">Client</label>
        <select id="client" name="client" required>${opts}</select>
      </div>
      <div style="flex:0 0 auto">
        <button class="primary" type="submit">Load clusters →</button>
      </div>
    </div>
  </form>
</section>

<section class="card">
  <h2>How it works</h2>
  <ol class="help" style="font-size:13px;color:var(--ink);line-height:1.7">
    <li>Select a client, see every published blog cluster, tick which ones to regenerate.</li>
    <li>Optionally upload a CSV to pre-select clusters in bulk.</li>
    <li>Run dry-run first to preview prompts without spending image-gen budget.</li>
    <li>Live-tail the run; download the CSV when it finishes.</li>
    <li>Hand the CSV to the S3 replace tooling — <code>image_id</code> is column 1.</li>
  </ol>
</section>
`));
}

async function clustersPage(res: ServerResponse, slug: string) {
  const entry = findClient(slug);
  if (!entry) {
    sendHtml(res, 400, shell("Error", `<div class="banner err">'${esc(slug)}' is not in the CLIENTS allow-list.</div>`));
    return;
  }
  try {
    loadEnv();
  } catch (err) {
    sendHtml(res, 500, shell("Env error", `<div class="banner err">Env not configured: ${esc((err as Error).message)}</div>`));
    return;
  }

  let project: ProjectRow | null = null;
  let clusters: ClusterRow[] = [];
  try {
    project = await lookupProjectById(entry.projectId);
    if (!project) {
      sendHtml(res, 404, shell("Not found", `<div class="banner err">Project <code>${esc(entry.projectId)}</code> not found in DB.</div>`));
      return;
    }
    clusters = await listPublishedBlogClusters(entry.projectId);
  } catch (err) {
    sendHtml(res, 500, shell("DB error", `<div class="banner err">DB query failed: ${esc((err as Error).message)}</div>`));
    return;
  }

  // S3 fetch for inline-image counts is the slow part — do it in parallel
  // with a shared cache. Cap concurrency to avoid hammering S3 from a UI page.
  const s3Cache = new Map<string, string | null>();
  const stagingSubdomain = project.staging_subdomain;
  const rows: { c: ClusterRow; total: number; counts: Record<string, number> }[] = [];
  const CONCURRENCY = 8;
  let cursor = 0;
  async function worker() {
    while (cursor < clusters.length) {
      const i = cursor++;
      const c = clusters[i]!;
      const records = await collectImageRecords([c], { stagingSubdomain, s3Cache });
      const counts: Record<string, number> = {};
      for (const r of records) counts[r.asset] = (counts[r.asset] ?? 0) + 1;
      rows[i] = { c, total: records.length, counts };
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const totalImages = rows.reduce((sum, r) => sum + r.total, 0);
  const summary: Record<string, number> = {};
  for (const r of rows) for (const [k, v] of Object.entries(r.counts)) summary[k] = (summary[k] ?? 0) + v;

  const tbody = rows
    .map(({ c, total, counts }, i) => `
<tr data-cluster-id="${esc(c.id)}" data-topic="${esc((c.topic ?? "").toLowerCase())}">
  <td><input type="checkbox" name="cluster_id" value="${esc(c.id)}" id="c${i}" checked onchange="updateSelected()"></td>
  <td class="topic"><label for="c${i}">${esc(c.topic ?? "(no topic)")}</label></td>
  <td class="cid"><code>${esc(c.id)}</code></td>
  <td>${total}</td>
  <td>${Object.entries(counts).map(([k, v]) => `<span class="pill ${esc(k)}">${esc(k)}:${v}</span>`).join(" ")}</td>
  <td>${esc(new Date(c.updated_at).toISOString().slice(0, 10))}</td>
</tr>`)
    .join("");

  const summaryBadges = Object.entries(summary)
    .sort(([, a], [, b]) => b - a)
    .map(([k, v]) => `<span class="pill ${esc(k)}">${esc(k)}: ${v}</span>`)
    .join(" ");

  const body = `
<section class="card">
  <h1>${esc(project.name ?? slug)} <span style="color:var(--ink-faint);font-weight:400;font-size:14px">/ ${esc(slug)}</span></h1>
  <div class="sub">project_id <code>${esc(project.id)}</code> · ${clusters.length} published blog clusters · ${totalImages} total images (${summaryBadges})</div>
</section>

<section class="card">
  <h2>Run options</h2>
  <form method="post" action="/regen" id="regen-form">
    <input type="hidden" name="client" value="${esc(slug)}">
    <fieldset>
      <div class="row">
        <div class="check-row" style="flex:0 0 auto">
          <input type="checkbox" id="dry_run" name="dry_run" checked>
          <label for="dry_run">Dry-run (build prompts only, no image generation)</label>
        </div>
        <div class="check-row" style="flex:0 0 auto">
          <input type="checkbox" id="use_saved_token" name="use_saved_token">
          <label for="use_saved_token">Use saved graphic_token (mode B)</label>
        </div>
      </div>
      <div class="row" style="margin-top:12px">
        <div>
          <label for="asset_types">Asset types</label>
          <input type="text" id="asset_types" name="asset_types" placeholder="cover,thumbnail,internal (blank = all)">
        </div>
        <div style="flex:0 0 200px">
          <label for="provider">Provider</label>
          <select id="provider" name="provider">
            <option value="">default (env)</option>
            <option value="replicate">replicate</option>
            <option value="fal">fal</option>
          </select>
        </div>
      </div>
    </fieldset>
  </form>
</section>

<section class="card">
  <h2>Import CSV (optional)</h2>
  <p class="help">Upload a CSV to pre-select clusters in bulk instead of clicking each row. Parsing happens in your browser — nothing is sent to the server.</p>
  <div class="help">
    <strong>Required column:</strong>
    <ul>
      <li><code>cluster_id</code> — the UUID from the <code>clusters</code> table. Matched against the rows below; matching rows get checked, non-matching rows get unchecked.</li>
    </ul>
    <strong>Recognised optional columns (currently ignored):</strong>
    <ul>
      <li><code>image_id</code> — for future per-image scoping.</li>
      <li><code>asset_type</code> — pre-fill the asset-type filter above.</li>
      <li><code>topic</code>, <code>page_status</code>, anything else — ignored.</li>
    </ul>
    Header row is required; column order doesn't matter; quoted commas are handled.
  </div>
  <div class="row" style="margin-top:12px">
    <div>
      <label for="csv-upload">CSV file</label>
      <input type="file" id="csv-upload" accept=".csv,text/csv">
    </div>
    <div style="flex:0 0 auto">
      <button type="button" id="csv-clear" onclick="clearCsv()">Clear filter</button>
    </div>
  </div>
  <div id="csv-result" class="banner info" style="display:none;margin-top:12px"></div>
</section>

<section class="card" style="padding:0">
  <div class="toolbar" style="padding:12px 20px">
    <div class="check-row">
      <input type="checkbox" id="all" checked onchange="toggleAll(this.checked)">
      <label for="all"><strong id="select-label">Select all</strong></label>
    </div>
    <div class="grow">
      <input type="text" id="topic-filter" placeholder="Filter by topic…" oninput="filterTopics(this.value)">
    </div>
    <div class="selected-count">
      Selected: <strong id="selected-count">${rows.length}</strong> / ${rows.length}
    </div>
  </div>
  <table class="cluster-list">
    <thead>
      <tr>
        <th style="width:40px"></th>
        <th>Topic</th>
        <th style="width:300px">cluster_id</th>
        <th style="width:60px">imgs</th>
        <th>by type</th>
        <th style="width:100px">updated</th>
      </tr>
    </thead>
    <tbody>${tbody}</tbody>
  </table>
</section>

<div class="sticky-actions">
  <div class="meta">Logs stream live after submit; CSV + HTML report download links appear when the run finishes.</div>
  <button class="primary" type="submit" form="regen-form" onclick="copySelectedToForm(event)">Run regen on selected →</button>
</div>
`;

  const scripts = `<script>
const tbody = document.querySelector('table.cluster-list tbody');
const allBox = document.getElementById('all');
const countEl = document.getElementById('selected-count');
const totalCount = ${rows.length};

function visibleRows() {
  return tbody ? Array.from(tbody.querySelectorAll('tr:not(.row-hidden)')) : [];
}
function allRows() {
  return tbody ? Array.from(tbody.querySelectorAll('tr')) : [];
}
function updateSelected() {
  const checked = allRows().filter(r => r.querySelector('input[type=checkbox]')?.checked).length;
  countEl.textContent = checked;
  if (allBox) allBox.checked = checked === totalCount;
}
function toggleAll(on) {
  for (const r of visibleRows()) {
    const cb = r.querySelector('input[type=checkbox]');
    if (cb) cb.checked = on;
  }
  updateSelected();
}
function filterTopics(q) {
  q = q.toLowerCase().trim();
  for (const r of allRows()) {
    const topic = r.dataset.topic ?? '';
    if (!q || topic.includes(q)) r.classList.remove('row-hidden');
    else r.classList.add('row-hidden');
  }
}
function copySelectedToForm(e) {
  // Copy selected cluster_id values as hidden inputs into the form.
  const form = document.getElementById('regen-form');
  if (!form) return;
  // Remove old hidden cluster_id inputs we appended previously.
  for (const old of form.querySelectorAll('input[data-injected]')) old.remove();
  const ids = allRows().filter(r => r.querySelector('input[type=checkbox]')?.checked).map(r => r.dataset.clusterId);
  if (ids.length === 0) {
    e.preventDefault();
    alert('Pick at least one cluster.');
    return;
  }
  for (const id of ids) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'cluster_id';
    input.value = id;
    input.dataset.injected = '1';
    form.appendChild(input);
  }
}

// ── CSV upload (client-side, no server round-trip) ──
const csvInput = document.getElementById('csv-upload');
const csvResult = document.getElementById('csv-result');

function parseCsv(text) {
  // Tolerant CSV parser: header row + commas, quoted fields with "" escapes.
  const rows = [];
  let i = 0, cur = '', row = [], inQ = false;
  while (i < text.length) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i+1] === '"') { cur += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      cur += ch; i++; continue;
    }
    if (ch === '"') { inQ = true; i++; continue; }
    if (ch === ',') { row.push(cur); cur = ''; i++; continue; }
    if (ch === '\\n' || ch === '\\r') {
      if (ch === '\\r' && text[i+1] === '\\n') i++;
      row.push(cur); rows.push(row); row = []; cur = ''; i++; continue;
    }
    cur += ch; i++;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function clearCsv() {
  csvInput.value = '';
  csvResult.style.display = 'none';
  for (const r of allRows()) r.classList.remove('row-matched');
  // restore: check all
  for (const r of allRows()) {
    const cb = r.querySelector('input[type=checkbox]');
    if (cb) cb.checked = true;
  }
  if (allBox) allBox.checked = true;
  updateSelected();
}

csvInput?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  const rows = parseCsv(text).filter(r => r.length && r.some(c => c.trim()));
  if (rows.length < 2) {
    csvResult.className = 'banner err';
    csvResult.style.display = 'block';
    csvResult.textContent = 'CSV is empty or has only a header row.';
    return;
  }
  const headers = rows[0].map(h => h.trim().toLowerCase());
  const idCol = headers.indexOf('cluster_id');
  if (idCol === -1) {
    csvResult.className = 'banner err';
    csvResult.style.display = 'block';
    csvResult.textContent = 'CSV must have a "cluster_id" column.';
    return;
  }
  const wanted = new Set();
  for (let r = 1; r < rows.length; r++) {
    const v = (rows[r][idCol] ?? '').trim();
    if (v) wanted.add(v);
  }
  let matched = 0;
  for (const tr of allRows()) {
    const cb = tr.querySelector('input[type=checkbox]');
    if (!cb) continue;
    const id = tr.dataset.clusterId;
    if (wanted.has(id)) { cb.checked = true; tr.classList.add('row-matched'); matched++; }
    else { cb.checked = false; tr.classList.remove('row-matched'); }
  }
  if (allBox) allBox.checked = false;
  updateSelected();
  csvResult.className = matched ? 'banner ok' : 'banner warn';
  csvResult.style.display = 'block';
  csvResult.innerHTML = matched
    ? '<strong>Matched ' + matched + '</strong> of ' + wanted.size + ' cluster_ids from <code>' + file.name + '</code>. Non-matching cluster_ids in your CSV were ignored.'
    : 'No cluster_ids in your CSV matched any cluster on this page (uploaded ' + wanted.size + ' ids).';
});

updateSelected();
</script>`;

  sendHtml(res, 200, shell(`${slug} · clusters`, body, scripts));
}

async function readBody(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function startRegen(opts: {
  client: string;
  clusterIds: string[];
  dryRun: boolean;
  useSavedToken: boolean;
  assetTypes?: string;
  provider?: string;
}): RunState {
  const id = randomUUID().slice(0, 8);
  const args = ["tsx", "src/cli.ts", "regen", "--client", opts.client];
  if (opts.dryRun) args.push("--dry-run");
  if (opts.useSavedToken) args.push("--use-saved-token");
  if (opts.clusterIds.length) args.push("--cluster-ids", opts.clusterIds.join(","));
  if (opts.assetTypes) args.push("--asset-types", opts.assetTypes);
  if (opts.provider) args.push("--provider", opts.provider);

  const proc = spawn("npx", args, {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  const state: RunState = {
    id,
    client: opts.client,
    args,
    startedAt: new Date().toISOString(),
    log: [],
    done: false,
    exitCode: null,
    proc,
    listeners: new Set(),
  };
  RUNS.set(id, state);

  const ondata = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    state.log.push(text);
    const csvMatch = text.match(/regen: csv=(.+?)\n/);
    if (csvMatch && csvMatch[1]) state.csvPath = csvMatch[1].trim();
    const htmlMatch = text.match(/regen: html=(.+?)\n/);
    if (htmlMatch && htmlMatch[1]) state.htmlPath = htmlMatch[1].trim();
    for (const l of state.listeners) {
      l.write(`data: ${JSON.stringify({ text })}\n\n`);
    }
  };
  proc.stdout?.on("data", ondata);
  proc.stderr?.on("data", ondata);
  proc.on("close", (code) => {
    state.done = true;
    state.exitCode = code;
    for (const l of state.listeners) {
      l.write(
        `event: end\ndata: ${JSON.stringify({ code, csvPath: state.csvPath, htmlPath: state.htmlPath })}\n\n`,
      );
      l.end();
    }
    state.listeners.clear();
  });

  return state;
}

async function regenPostHandler(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req);
  const client = body.get("client") ?? "";
  if (!findClient(client)) {
    sendHtml(res, 400, shell("Error", `<div class="banner err">unknown client</div>`));
    return;
  }
  const clusterIds = body.getAll("cluster_id");
  if (clusterIds.length === 0) {
    sendHtml(res, 400, shell("Error", `<div class="banner err">No clusters selected — pick at least one.</div>`));
    return;
  }
  const state = startRegen({
    client,
    clusterIds,
    dryRun: body.get("dry_run") === "on",
    useSavedToken: body.get("use_saved_token") === "on",
    assetTypes: body.get("asset_types") || undefined,
    provider: body.get("provider") || undefined,
  });
  res.writeHead(303, { location: `/runs/${state.id}` });
  res.end();
}

function runListPage(res: ServerResponse) {
  const items = [...RUNS.values()]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map(
      (r) => `
<tr>
  <td><a href="/runs/${esc(r.id)}"><code>${esc(r.id)}</code></a></td>
  <td>${esc(r.client)}</td>
  <td><code style="font-size:11px">${esc(r.startedAt)}</code></td>
  <td>${
    r.done
      ? r.exitCode === 0
        ? `<span class="pill internal">done</span>`
        : `<span class="pill external">exit ${r.exitCode}</span>`
      : `<span class="pill infographic">running</span>`
  }</td>
  <td>${r.csvPath ? `<a href="/files?p=${encodeURIComponent(r.csvPath)}">CSV</a>` : ""} ${r.htmlPath ? `<a href="/files?p=${encodeURIComponent(r.htmlPath)}" target="_blank">report</a>` : ""}</td>
</tr>`,
    )
    .join("");

  sendHtml(res, 200, shell("Runs", `
<section class="card">
  <h1>Runs <span style="color:var(--ink-faint);font-weight:400;font-size:14px">(this server session)</span></h1>
  <div class="sub">In-memory list of regen jobs spawned by this UI; cleared when the server restarts.</div>
</section>
<section class="card" style="padding:0">
${
    RUNS.size === 0
      ? `<div style="padding:24px;text-align:center;color:var(--ink-muted)">No runs yet. <a href="/">Start one →</a></div>`
      : `<table class="cluster-list"><thead><tr><th>id</th><th>client</th><th>started</th><th>status</th><th>output</th></tr></thead><tbody>${items}</tbody></table>`
  }
</section>
`));
}

function runPage(res: ServerResponse, id: string) {
  const state = RUNS.get(id);
  if (!state) {
    sendHtml(res, 404, shell("Not found", `<div class="banner err">run ${esc(id)} not found</div>`));
    return;
  }
  const initial = esc(state.log.join(""));
  const cmd = esc(`npx ${state.args.join(" ")}`);

  const body = `
<section class="card">
  <h1>Run <code>${esc(id)}</code></h1>
  <div class="sub">client <code>${esc(state.client)}</code> · started <code>${esc(state.startedAt)}</code></div>
  <details style="margin-top:8px">
    <summary class="help">command</summary>
    <pre style="background:#f1f5f9;padding:8px 12px;border-radius:6px;font-size:12px;overflow:auto"><code>${cmd}</code></pre>
  </details>
</section>

<section class="card">
  <h2>Status</h2>
  <div id="status">
    ${state.done ? (state.exitCode === 0 ? `<div class="banner ok">finished, exit 0</div>` : `<div class="banner err">exited with code ${state.exitCode}</div>`) : `<div class="banner info">streaming…</div>`}
  </div>
  <div id="links" style="margin-top:8px">
    ${state.csvPath ? `<a class="btn" href="/files?p=${encodeURIComponent(state.csvPath)}">⬇ Download CSV</a> ` : ""}
    ${state.htmlPath ? `<a class="btn primary" href="/files?p=${encodeURIComponent(state.htmlPath)}" target="_blank">Open HTML report ↗</a>` : ""}
  </div>
</section>

<section class="card">
  <h2>Log</h2>
  <div id="log" class="log">${initial}</div>
</section>
`;

  const scripts = `<script>
const logEl = document.getElementById('log');
const statusEl = document.getElementById('status');
const linksEl = document.getElementById('links');
${state.done ? "" : `
const es = new EventSource('/runs/${esc(id)}/events');
es.onmessage = (ev) => {
  try {
    const { text } = JSON.parse(ev.data);
    logEl.textContent += text;
    logEl.scrollTop = logEl.scrollHeight;
  } catch {}
};
es.addEventListener('end', (ev) => {
  const { code, csvPath, htmlPath } = JSON.parse(ev.data);
  statusEl.innerHTML = code === 0 ? '<div class="banner ok">finished, exit 0</div>' : '<div class="banner err">exited with code ' + code + '</div>';
  const links = [];
  if (csvPath) links.push('<a class="btn" href="/files?p=' + encodeURIComponent(csvPath) + '">⬇ Download CSV</a>');
  if (htmlPath) links.push('<a class="btn primary" href="/files?p=' + encodeURIComponent(htmlPath) + '" target="_blank">Open HTML report ↗</a>');
  linksEl.innerHTML = links.join(' ');
  es.close();
});
es.onerror = () => {};
`}
</script>`;

  sendHtml(res, 200, shell(`run ${id}`, body, scripts));
}

function runEvents(res: ServerResponse, id: string) {
  const state = RUNS.get(id);
  if (!state) {
    send(res, 404, "text/plain", "not found");
    return;
  }
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(": connected\n\n");
  if (state.done) {
    res.write(
      `event: end\ndata: ${JSON.stringify({ code: state.exitCode, csvPath: state.csvPath, htmlPath: state.htmlPath })}\n\n`,
    );
    res.end();
    return;
  }
  state.listeners.add(res);
  res.on("close", () => state.listeners.delete(res));
}

function serveFile(res: ServerResponse, fsPath: string) {
  const abs = path.resolve(fsPath);
  const root = path.resolve(process.cwd());
  if (!abs.startsWith(root)) {
    send(res, 400, "text/plain", "path outside project root");
    return;
  }
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    send(res, 404, "text/plain", "not found");
    return;
  }
  const ext = path.extname(abs).toLowerCase();
  const types: Record<string, string> = {
    ".csv": "text/csv",
    ".html": "text/html; charset=utf-8",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
  };
  res.writeHead(200, {
    "content-type": types[ext] ?? "application/octet-stream",
    "content-length": String(stat.size),
  });
  createReadStream(abs).pipe(res);
}

// ────────────────────────────────────────────────────────────────────────
// Server bootstrap
// ────────────────────────────────────────────────────────────────────────

export function startWebServer(port: number): void {
  try {
    loadEnv();
    process.stdout.write(`web: env ok\n`);
  } catch (err) {
    process.stderr.write(`web: env not ready — ${(err as Error).message}\n`);
    process.stderr.write(`web: server will boot anyway; pages that need the DB will show an error.\n`);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const p = url.pathname;
      const method = req.method ?? "GET";

      if (method === "GET" && p === "/") return homePage(res);
      if (method === "GET" && p === "/clusters") {
        const slug = url.searchParams.get("client") ?? "";
        return await clustersPage(res, slug);
      }
      if (method === "POST" && p === "/regen") return await regenPostHandler(req, res);
      if (method === "GET" && p === "/runs") return runListPage(res);
      const runMatch = /^\/runs\/([a-f0-9]+)(\/events)?$/.exec(p);
      if (method === "GET" && runMatch) {
        const [, id, suffix] = runMatch;
        if (!id) return send(res, 404, "text/plain", "not found");
        if (suffix === "/events") return runEvents(res, id);
        return runPage(res, id);
      }
      if (method === "GET" && p === "/files") {
        const fp = url.searchParams.get("p") ?? "";
        return serveFile(res, fp);
      }
      send(res, 404, "text/plain", "not found");
    } catch (err) {
      send(res, 500, "text/plain", `error: ${(err as Error).message}`);
    }
  });

  server.listen(port, () => {
    process.stdout.write(`web: listening on http://localhost:${port}\n`);
  });

  process.on("SIGINT", async () => {
    await closePool();
    server.close(() => process.exit(0));
  });
}

// AssetType is exported only to satisfy strict TS unused-import checks
// in the future; harmless at runtime.
export type { AssetType };
