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
import { collectImageRecords, type ImageRecord } from "./pageInfo.js";
import { loadEnv } from "./env.js";
import { loadBrandGuidelines, saveBrandGuidelines } from "./tokens.js";

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

function shell(title: string, body: string, scripts = "", crumb = ""): string {
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
    --shadow-lg: 0 10px 30px rgba(16,24,40,.12);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font: 14px/1.5 -apple-system, "Inter", system-ui, "Segoe UI", sans-serif;
    color: var(--ink); background: var(--bg); min-height: 100vh;
    -webkit-font-smoothing: antialiased;
  }
  a { color: var(--brand); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { font: 12px ui-monospace, "JetBrains Mono", Menlo, monospace; background: #f1f5f9; padding: 2px 6px; border-radius: 4px; color: #334155; word-break: break-all; }

  header.app {
    background: #fff; border-bottom: 1px solid var(--border);
    padding: 12px 24px; display: flex; align-items: center; gap: 14px;
    position: sticky; top: 0; z-index: 30;
  }
  header.app img.logo { height: 22px; display: block; }
  header.app .title { font-size: 14px; font-weight: 600; letter-spacing: -.005em; }
  header.app .crumb { color: var(--ink-faint); font-weight: 400; margin-left: 4px; font-size: 13px; }
  header.app nav { margin-left: auto; display: flex; gap: 18px; font-size: 13px; }
  header.app nav a { color: var(--ink-muted); }
  header.app nav a:hover { color: var(--ink); text-decoration: none; }

  main { max-width: 1320px; margin: 0 auto; padding: 20px 24px 100px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow); padding: 18px; margin-bottom: 14px; }
  .card.compact { padding: 14px 18px; }
  .card h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: var(--ink-muted); margin: 0 0 10px; font-weight: 600; }
  .card h1 { font-size: 20px; margin: 0 0 4px; letter-spacing: -.005em; }
  .card .sub { color: var(--ink-muted); font-size: 12.5px; }

  label { display: block; font-size: 12px; color: var(--ink-muted); margin-bottom: 4px; font-weight: 500; }
  input[type="text"], input[type="search"], input[type="number"], select, textarea, input[type="file"] {
    font: inherit; padding: 7px 10px; border: 1px solid var(--border-strong); border-radius: 6px;
    background: #fff; color: var(--ink); width: 100%;
  }
  input:focus, select:focus, textarea:focus { outline: 2px solid var(--accent-bg); border-color: var(--brand); }
  input[type="checkbox"] { accent-color: var(--brand); width: 15px; height: 15px; cursor: pointer; }
  textarea { font-family: ui-monospace, Menlo, monospace; font-size: 12px; line-height: 1.5; min-height: 110px; resize: vertical; }

  button, .btn {
    font: inherit; font-weight: 500; padding: 7px 14px;
    border: 1px solid var(--border-strong); border-radius: 6px;
    background: #fff; color: var(--ink); cursor: pointer;
    transition: background .12s, border-color .12s; display: inline-flex; align-items: center; gap: 6px;
  }
  button:hover, .btn:hover { background: #f9fafb; }
  button.primary, .btn.primary { background: var(--brand); color: #fff; border-color: var(--brand); }
  button.primary:hover, .btn.primary:hover { background: var(--brand-hover); border-color: var(--brand-hover); }
  button.ghost, .btn.ghost { background: transparent; border: none; color: var(--ink-muted); padding: 4px 8px; }
  button.ghost:hover { color: var(--ink); background: #f1f5f9; }
  button:disabled, .btn:disabled, button.primary:disabled { background: #cbd5e1; border-color: #cbd5e1; color: #fff; cursor: not-allowed; }

  /* Tables */
  table { width: 100%; border-collapse: collapse; }
  table.cluster-list th, table.cluster-list td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--border); font-size: 13px; vertical-align: middle; }
  table.cluster-list th { background: #f8fafc; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-muted); position: sticky; top: 49px; z-index: 5; }
  table.cluster-list tr.row-hidden { display: none; }
  table.cluster-list tr.row-matched { background: #fefce8; }
  table.cluster-list tr:hover { background: #f8fafc; }
  table.cluster-list td.topic { max-width: 360px; }
  table.cluster-list td.topic .t { font-weight: 500; line-height: 1.35; }
  table.cluster-list td.topic .cid { font-size: 10.5px; color: var(--ink-muted); margin-top: 2px; word-break: break-all; }
  table.cluster-list td.preview img { width: 64px; height: 36px; object-fit: cover; border-radius: 4px; border: 1px solid var(--border); display: block; background: #f1f5f9; }
  table.cluster-list td.preview .placeholder { width: 64px; height: 36px; border-radius: 4px; border: 1px dashed var(--border-strong); background: #f8fafc; }
  table.cluster-list td.types .pills-wrap { display: flex; flex-wrap: wrap; gap: 3px; }

  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 500; }
  .pill.cover { background: #dbeafe; color: #1e40af; }
  .pill.thumbnail { background: #ede9fe; color: #5b21b6; }
  .pill.infographic { background: #fef3c7; color: #92400e; }
  .pill.internal { background: #d1fae5; color: #065f46; }
  .pill.external { background: #fce7f3; color: #9d174d; }
  .pill.generic { background: #e5e7eb; color: #374151; }

  /* Toolbar */
  .toolbar { display: flex; gap: 10px; align-items: center; padding: 12px 18px; flex-wrap: wrap; }
  .toolbar .search { flex: 1; min-width: 240px; }
  .toolbar .meta { font-size: 12px; color: var(--ink-muted); }
  .toolbar .meta strong { color: var(--ink); }

  /* Action bar (sticky bottom) */
  .action-bar {
    position: fixed; bottom: 0; left: 0; right: 0;
    background: rgba(255,255,255,.97); backdrop-filter: blur(10px);
    border-top: 1px solid var(--border-strong);
    padding: 12px 24px; z-index: 20;
    display: flex; gap: 12px; align-items: center;
  }
  .action-bar .stats { color: var(--ink-muted); font-size: 13px; }
  .action-bar .stats strong { color: var(--ink); }
  .action-bar .right { margin-left: auto; display: flex; gap: 8px; align-items: center; }

  /* Banner */
  .banner { padding: 11px 14px; border-radius: 8px; margin-bottom: 12px; font-size: 13px; }
  .banner.err { background: var(--err-bg); color: var(--err); border: 1px solid #fca5a5; }
  .banner.ok { background: var(--ok-bg); color: var(--ok); border: 1px solid #86efac; }
  .banner.warn { background: var(--warn-bg); color: var(--warn); border: 1px solid #fde68a; }
  .banner.info { background: var(--accent-bg); color: var(--brand); border: 1px solid #c7d2fe; }

  /* Drawer (right slide-in) */
  .drawer-overlay {
    position: fixed; inset: 0; background: rgba(15,23,42,.45);
    opacity: 0; pointer-events: none; transition: opacity .18s ease;
    z-index: 40;
  }
  .drawer-overlay.open { opacity: 1; pointer-events: auto; }
  .drawer {
    position: fixed; top: 0; right: 0; height: 100vh; width: min(720px, 92vw);
    background: #fff; box-shadow: var(--shadow-lg);
    transform: translateX(100%); transition: transform .22s ease;
    z-index: 41; display: flex; flex-direction: column;
  }
  .drawer.open { transform: translateX(0); }
  .drawer header { padding: 14px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 10px; }
  .drawer header h3 { margin: 0; font-size: 15px; font-weight: 600; flex: 1; }
  .drawer .body { flex: 1; overflow-y: auto; padding: 16px 20px; }
  .drawer .body .desc-cluster { color: var(--ink-muted); font-size: 12px; margin-bottom: 14px; }

  .img-card {
    border: 1px solid var(--border); border-radius: 10px;
    padding: 12px; margin-bottom: 10px;
    display: grid; grid-template-columns: 22px 96px 1fr; gap: 12px;
    align-items: start;
  }
  .img-card.selected { border-color: var(--brand); background: #f5f3ff; }
  .img-card .pre { width: 96px; height: 60px; border-radius: 6px; border: 1px solid var(--border); background: #f1f5f9; overflow: hidden; display: flex; align-items: center; justify-content: center; }
  .img-card .pre img { width: 100%; height: 100%; object-fit: cover; }
  .img-card .pre .ph { font-size: 10px; color: var(--ink-faint); text-align: center; padding: 4px; }
  .img-card .meta-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 4px; }
  .img-card .meta-row code { font-size: 10.5px; }
  .img-card .desc { font-size: 12.5px; color: var(--ink-muted); line-height: 1.45; }

  .drawer footer { padding: 12px 20px; border-top: 1px solid var(--border); display: flex; gap: 10px; align-items: center; }
  .drawer footer .meta { color: var(--ink-muted); font-size: 12.5px; flex: 1; }

  details > summary { cursor: pointer; user-select: none; list-style: none; }
  details > summary::-webkit-details-marker { display: none; }
  details > summary::before { content: "▸"; display: inline-block; margin-right: 6px; transition: transform .15s; color: var(--ink-faint); }
  details[open] > summary::before { transform: rotate(90deg); }
  details > summary h2 { display: inline; }

  /* Combobox */
  .combobox { position: relative; }
  .combobox input { padding-right: 36px; }
  .combobox .arrow { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); color: var(--ink-faint); pointer-events: none; }
  .combobox .menu {
    position: absolute; top: calc(100% + 4px); left: 0; right: 0;
    background: #fff; border: 1px solid var(--border-strong); border-radius: 6px;
    box-shadow: var(--shadow);
    max-height: 260px; overflow-y: auto; z-index: 5;
    display: none;
  }
  .combobox.open .menu { display: block; }
  .combobox .menu .opt { padding: 8px 12px; cursor: pointer; font-size: 13px; }
  .combobox .menu .opt:hover, .combobox .menu .opt.active { background: var(--accent-bg); color: var(--brand); }
  .combobox .menu .opt .pid { font-size: 11px; color: var(--ink-faint); margin-top: 2px; }

  .log { background: #0f172a; color: #e2e8f0; padding: 14px 16px; border-radius: 8px; font: 12px/1.55 ui-monospace, "JetBrains Mono", Menlo, monospace; white-space: pre-wrap; max-height: 60vh; overflow: auto; }

  .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: end; }
  .row > * { flex: 1; min-width: 160px; }
  .check-row { display: flex; align-items: center; gap: 8px; font-size: 13px; }
  .check-row label { display: inline; margin: 0; color: var(--ink); font-weight: 400; cursor: pointer; }
  fieldset { border: none; padding: 0; margin: 0; }
</style>
</head>
<body>
<header class="app">
  <img class="logo" src="${esc(LOGO_URL)}" alt="Gushwork">
  <span class="title">${esc(APP_TITLE)}</span>${crumb ? `<span class="crumb">/ ${crumb}</span>` : ""}
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
function sendJson(res: ServerResponse, status: number, body: unknown) {
  send(res, status, "application/json", JSON.stringify(body));
}

// ────────────────────────────────────────────────────────────────────────
// Home — searchable client picker → Import → workspace
// ────────────────────────────────────────────────────────────────────────

function homePage(res: ServerResponse) {
  const optsJson = JSON.stringify(CLIENTS.map((c) => ({ slug: c.slug, projectId: c.projectId })));

  sendHtml(res, 200, shell("Home", `
<section class="card">
  <h1>Blog Image Update</h1>
  <div class="sub">Bulk-regenerate cover, thumbnail, and inline images for published blog pages in <code>gw_stormbreaker</code>. Pick a client to enter its workspace.</div>
</section>

<section class="card">
  <h2>Import a client</h2>
  <form id="import-form" onsubmit="goToWorkspace(event)" autocomplete="off">
    <div class="row">
      <div style="flex:2">
        <label for="client-input">Client</label>
        <div class="combobox" id="combo">
          <input type="text" id="client-input" placeholder="Search by slug or project_id…" autocomplete="off">
          <span class="arrow">▾</span>
          <div class="menu" id="combo-menu"></div>
        </div>
        <input type="hidden" id="client-slug" name="client" required>
      </div>
      <div style="flex:0 0 auto">
        <button class="primary" type="submit" id="import-btn" disabled>Import →</button>
      </div>
    </div>
  </form>
</section>

<section class="card">
  <h2>How the workflow runs</h2>
  <ol class="sub" style="font-size:13px;color:var(--ink);line-height:1.7;padding-left:18px;margin:0">
    <li>Pick the client → land in its workspace with every published blog cluster listed.</li>
    <li>Use search to narrow by topic or cluster_id; tick whole clusters or open one to pick individual images.</li>
    <li>(Optional) Drop brand guidelines into the workspace panel — they get injected into every prompt's <code>business_context.client_brand_guidelines</code>.</li>
    <li>Click <strong>Generate selected</strong> → the regen kicks off, log streams live, CSV + HTML report appear when done.</li>
    <li>Phase 2 (not yet wired): apply approved images back to S3 directly. For now, the receiving PM uses the CSV / HTML.</li>
  </ol>
</section>
`, `<script>
const CLIENTS = ${optsJson};
const inp = document.getElementById('client-input');
const hidden = document.getElementById('client-slug');
const menu = document.getElementById('combo-menu');
const combo = document.getElementById('combo');
const btn = document.getElementById('import-btn');
let activeIdx = -1;
let visible = [];

function render(filter) {
  const f = filter.toLowerCase().trim();
  visible = CLIENTS.filter(c => !f || c.slug.toLowerCase().includes(f) || c.projectId.toLowerCase().includes(f));
  if (visible.length === 0) {
    menu.innerHTML = '<div class="opt" style="color:var(--ink-faint);cursor:default">no matches</div>';
  } else {
    menu.innerHTML = visible.map((c, i) =>
      '<div class="opt' + (i === activeIdx ? ' active' : '') + '" data-i="' + i + '"><div>' + c.slug + '</div><div class="pid">' + c.projectId + '</div></div>'
    ).join('');
  }
}
function pick(i) {
  if (i < 0 || i >= visible.length) return;
  const c = visible[i];
  inp.value = c.slug;
  hidden.value = c.slug;
  combo.classList.remove('open');
  btn.disabled = false;
}
inp.addEventListener('focus', () => { render(inp.value); combo.classList.add('open'); });
inp.addEventListener('input', (e) => { hidden.value = ''; btn.disabled = true; activeIdx = -1; render(e.target.value); combo.classList.add('open'); });
inp.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, visible.length - 1); render(inp.value); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); render(inp.value); }
  else if (e.key === 'Enter') { e.preventDefault(); if (activeIdx >= 0) pick(activeIdx); else if (visible.length === 1) pick(0); }
  else if (e.key === 'Escape') combo.classList.remove('open');
});
menu.addEventListener('mousedown', (e) => {
  const el = e.target.closest('.opt[data-i]');
  if (!el) return;
  pick(Number(el.dataset.i));
});
document.addEventListener('mousedown', (e) => {
  if (!combo.contains(e.target)) combo.classList.remove('open');
});
function goToWorkspace(e) {
  e.preventDefault();
  if (!hidden.value) return;
  window.location.href = '/workspace/' + encodeURIComponent(hidden.value);
}
render('');
</script>`));
}

// ────────────────────────────────────────────────────────────────────────
// Workspace — cluster table + brand guidelines + drawer
// ────────────────────────────────────────────────────────────────────────

interface ClusterPayload {
  id: string;
  topic: string;
  updated_at: string | null;
  cover_url: string | null;
  total: number;
  by_asset: Record<string, number>;
  images: Array<{
    id: string;
    asset: string;
    description: string;
    aspect: string;
    source: string;
    preview_url: string | null;
  }>;
}

async function workspacePage(res: ServerResponse, slug: string) {
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

  let project: ProjectRow | null;
  let clusters: ClusterRow[];
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

  const brand = (await loadBrandGuidelines(slug)) ?? "";

  // Parallel S3 fetches for inline-image counts.
  const s3Cache = new Map<string, string | null>();
  const stagingSubdomain = project.staging_subdomain;
  const recordsByCluster: Record<string, ImageRecord[]> = {};
  const CONCURRENCY = 8;
  let cursor = 0;
  async function worker() {
    while (cursor < clusters.length) {
      const i = cursor++;
      const c = clusters[i]!;
      const recs = await collectImageRecords([c], { stagingSubdomain, s3Cache });
      recordsByCluster[c.id] = recs;
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const payload: ClusterPayload[] = clusters.map((c) => {
    const recs = recordsByCluster[c.id] ?? [];
    const counts: Record<string, number> = {};
    for (const r of recs) counts[r.asset] = (counts[r.asset] ?? 0) + 1;
    const cover = recs.find((r) => r.asset === "cover");
    return {
      id: c.id,
      topic: c.topic ?? "(no topic)",
      updated_at: c.updated_at ? c.updated_at.toISOString().slice(0, 10) : null,
      cover_url: cover?.previewUrl ?? null,
      total: recs.length,
      by_asset: counts,
      images: recs.map((r) => ({
        id: r.imageId,
        asset: r.asset,
        description: r.description,
        aspect: r.aspectRatio,
        source: r.source,
        preview_url: r.previewUrl ?? null,
      })),
    };
  });

  const totalImages = payload.reduce((n, c) => n + c.total, 0);

  // Asset summary at the top
  const totalsByAsset: Record<string, number> = {};
  for (const c of payload) for (const [k, v] of Object.entries(c.by_asset)) totalsByAsset[k] = (totalsByAsset[k] ?? 0) + v;
  const totalsBadges = Object.entries(totalsByAsset)
    .sort(([, a], [, b]) => b - a)
    .map(([k, v]) => `<span class="pill ${esc(k)}">${esc(k)}: ${v}</span>`)
    .join(" ");

  // Render cluster rows
  const tbody = payload
    .map((c, i) => {
      const cover = c.cover_url
        ? `<img src="${esc(c.cover_url)}" alt="" loading="lazy">`
        : `<div class="placeholder"></div>`;
      const pills = Object.entries(c.by_asset)
        .map(([k, v]) => `<span class="pill ${esc(k)}">${esc(k)}: ${v}</span>`)
        .join(" ");
      return `
<tr data-cluster-id="${esc(c.id)}" data-topic="${esc(c.topic.toLowerCase())}">
  <td><input type="checkbox" class="cluster-select" data-cluster-id="${esc(c.id)}" onchange="onClusterCheck('${esc(c.id)}', this.checked)"></td>
  <td class="topic">
    <div class="t">${esc(c.topic)}</div>
    <div class="cid"><code>${esc(c.id)}</code> · ${esc(c.updated_at ?? "")}</div>
  </td>
  <td class="preview">${cover}</td>
  <td class="types"><div class="pills-wrap">${pills}</div></td>
  <td style="text-align:right">
    <button class="ghost" onclick="openDrawer('${esc(c.id)}')">Open ↗</button>
  </td>
</tr>`;
    })
    .join("");

  const body = `
<section class="card">
  <h1>${esc(project.name ?? slug)} <span style="color:var(--ink-faint);font-weight:400;font-size:14px">/ ${esc(slug)}</span></h1>
  <div class="sub">
    project_id <code>${esc(project.id)}</code> · ${clusters.length} published blog clusters · ${totalImages} images (${totalsBadges})
  </div>
</section>

<section class="card">
  <details${brand ? " open" : ""}>
    <summary><h2 style="display:inline">Brand guidelines (optional)</h2></summary>
    <div class="sub" style="margin:8px 0 10px">
      Freeform text injected into every prompt under <code>business_context.client_brand_guidelines</code>.
      Saved to <code>graphic-tokens/${esc(slug)}-brand.txt</code> (gitignored). Useful for color preferences,
      tone, things to avoid, mandatory taglines, etc. Other prompt inputs (graphic_token, asset prompts,
      aspect ratios) are managed in the background and don't change here.
    </div>
    <form id="brand-form" onsubmit="saveBrand(event)">
      <textarea id="brand-text" placeholder="e.g. Use deep navy and gold accents only. Avoid stock-photo human subjects. Always include a small Sentinel mark in the footer.">${esc(brand)}</textarea>
      <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
        <button type="submit" class="primary">Save brand guidelines</button>
        <span id="brand-status" class="sub"></span>
      </div>
    </form>
  </details>
</section>

<section class="card" style="padding:0">
  <div class="toolbar">
    <input type="search" id="topic-filter" class="search" placeholder="Search by topic or cluster_id…" oninput="filterClusters(this.value)">
    <div class="check-row" style="flex:0 0 auto">
      <input type="checkbox" id="all-clusters" onchange="toggleAllClusters(this.checked)">
      <label for="all-clusters">Select all (visible)</label>
    </div>
    <div class="meta" style="flex:0 0 auto">Showing <strong id="visible-count">${clusters.length}</strong> / ${clusters.length}</div>
  </div>
  <table class="cluster-list">
    <thead>
      <tr>
        <th style="width:40px"></th>
        <th>Topic / cluster_id</th>
        <th style="width:84px">cover</th>
        <th>asset breakdown</th>
        <th style="width:90px;text-align:right"></th>
      </tr>
    </thead>
    <tbody id="cluster-tbody">${tbody}</tbody>
  </table>
</section>

<!-- Drawer -->
<div class="drawer-overlay" id="overlay" onclick="closeDrawer()"></div>
<aside class="drawer" id="drawer" aria-hidden="true">
  <header>
    <h3 id="drawer-title">Cluster</h3>
    <button class="ghost" onclick="closeDrawer()">×</button>
  </header>
  <div class="body" id="drawer-body"></div>
  <footer>
    <div class="meta" id="drawer-meta">— images selected</div>
    <button onclick="selectAllInDrawer(true)">Select all</button>
    <button onclick="selectAllInDrawer(false)">Clear</button>
  </footer>
</aside>

<!-- Sticky bottom action bar -->
<div class="action-bar">
  <div class="stats">
    <strong id="bar-img-count">0</strong> images selected across <strong id="bar-cluster-count">0</strong> clusters
  </div>
  <div class="right">
    <div class="check-row">
      <input type="checkbox" id="bar-dry-run" checked>
      <label for="bar-dry-run">Dry-run (prompts only)</label>
    </div>
    <div class="check-row">
      <input type="checkbox" id="bar-saved-token">
      <label for="bar-saved-token">Use saved token</label>
    </div>
    <select id="bar-provider" style="width:auto">
      <option value="">provider: default</option>
      <option value="replicate">replicate</option>
      <option value="fal">fal</option>
    </select>
    <button class="primary" id="bar-run" onclick="runRegen()" disabled>Generate selected →</button>
  </div>
</div>
`;

  const scripts = `<script>
const SLUG = ${JSON.stringify(slug)};
const CLUSTERS = ${JSON.stringify(payload)};
// Per-cluster set of selected image IDs. Empty set = nothing selected.
// Selecting a cluster row pre-selects every image in that cluster.
const selection = new Map(); // cluster_id -> Set(image_id)

function imageIdsOf(clusterId) {
  const c = CLUSTERS.find(x => x.id === clusterId);
  return c ? c.images.map(i => i.id) : [];
}
function clusterById(id) { return CLUSTERS.find(c => c.id === id); }

// Cluster-level checkbox toggles all images in that cluster.
function onClusterCheck(clusterId, on) {
  if (on) selection.set(clusterId, new Set(imageIdsOf(clusterId)));
  else selection.delete(clusterId);
  refreshTotals();
  refreshDrawerIfOpen(clusterId);
}
function toggleAllClusters(on) {
  for (const tr of visibleRows()) {
    const cid = tr.dataset.clusterId;
    const cb = tr.querySelector('input.cluster-select');
    if (!cb || !cid) continue;
    cb.checked = on;
    if (on) selection.set(cid, new Set(imageIdsOf(cid)));
    else selection.delete(cid);
  }
  refreshTotals();
}
function visibleRows() {
  return Array.from(document.querySelectorAll('#cluster-tbody tr:not(.row-hidden)'));
}
function allRows() {
  return Array.from(document.querySelectorAll('#cluster-tbody tr'));
}
function filterClusters(q) {
  q = q.toLowerCase().trim();
  let n = 0;
  for (const tr of allRows()) {
    const topic = tr.dataset.topic ?? '';
    const cid = tr.dataset.clusterId ?? '';
    const match = !q || topic.includes(q) || cid.includes(q);
    tr.classList.toggle('row-hidden', !match);
    if (match) n++;
  }
  document.getElementById('visible-count').textContent = n;
  document.getElementById('all-clusters').checked = false;
}
function refreshTotals() {
  let imgs = 0, cls = 0;
  for (const [cid, set] of selection.entries()) {
    if (set.size > 0) { cls++; imgs += set.size; }
  }
  document.getElementById('bar-img-count').textContent = imgs;
  document.getElementById('bar-cluster-count').textContent = cls;
  document.getElementById('bar-run').disabled = imgs === 0;
  // Sync row checkboxes with selection state.
  for (const tr of allRows()) {
    const cid = tr.dataset.clusterId;
    if (!cid) continue;
    const cb = tr.querySelector('input.cluster-select');
    if (!cb) continue;
    const set = selection.get(cid);
    const total = imageIdsOf(cid).length;
    if (!set || set.size === 0) {
      cb.checked = false; cb.indeterminate = false;
    } else if (set.size === total) {
      cb.checked = true; cb.indeterminate = false;
    } else {
      cb.checked = false; cb.indeterminate = true;
    }
  }
}

// ── Drawer ──
let drawerClusterId = null;
function openDrawer(cid) {
  const c = clusterById(cid);
  if (!c) return;
  drawerClusterId = cid;
  const set = selection.get(cid) ?? new Set();
  document.getElementById('drawer-title').textContent = c.topic;
  const cards = c.images.map((img) => {
    const checked = set.has(img.id);
    const previewHtml = img.preview_url
      ? '<img src="' + img.preview_url + '" alt="" loading="lazy">'
      : '<div class="ph">no preview<br>available</div>';
    return '<label class="img-card' + (checked ? ' selected' : '') + '" data-img-id="' + img.id + '">' +
      '<input type="checkbox" class="img-toggle" ' + (checked ? 'checked' : '') + ' onchange="onImgToggle(this)">' +
      '<div class="pre">' + previewHtml + '</div>' +
      '<div>' +
        '<div class="meta-row">' +
          '<span class="pill ' + img.asset + '">' + img.asset + ' · ' + img.aspect + '</span>' +
          '<code>' + img.id + '</code>' +
        '</div>' +
        '<div class="desc">' + (img.description || '<em style="color:var(--ink-faint)">(no description)</em>') + '</div>' +
        '<div class="sub" style="margin-top:4px;font-size:11px;color:var(--ink-faint)">source: ' + img.source + '</div>' +
      '</div>' +
    '</label>';
  }).join('');
  document.getElementById('drawer-body').innerHTML =
    '<div class="desc-cluster">cluster <code>' + c.id + '</code> · ' + c.total + ' images · last updated ' + (c.updated_at ?? '') + '</div>' +
    cards;
  refreshDrawerMeta();
  document.getElementById('drawer').classList.add('open');
  document.getElementById('overlay').classList.add('open');
}
function closeDrawer() {
  document.getElementById('drawer').classList.remove('open');
  document.getElementById('overlay').classList.remove('open');
  drawerClusterId = null;
}
function onImgToggle(cb) {
  const card = cb.closest('.img-card');
  const imgId = card.dataset.imgId;
  card.classList.toggle('selected', cb.checked);
  if (!drawerClusterId) return;
  let set = selection.get(drawerClusterId);
  if (!set) { set = new Set(); selection.set(drawerClusterId, set); }
  if (cb.checked) set.add(imgId); else set.delete(imgId);
  if (set.size === 0) selection.delete(drawerClusterId);
  refreshDrawerMeta();
  refreshTotals();
}
function selectAllInDrawer(on) {
  if (!drawerClusterId) return;
  const cards = document.querySelectorAll('#drawer-body .img-card');
  for (const card of cards) {
    const cb = card.querySelector('input.img-toggle');
    cb.checked = on;
    card.classList.toggle('selected', on);
  }
  if (on) selection.set(drawerClusterId, new Set(imageIdsOf(drawerClusterId)));
  else selection.delete(drawerClusterId);
  refreshDrawerMeta();
  refreshTotals();
}
function refreshDrawerMeta() {
  if (!drawerClusterId) return;
  const set = selection.get(drawerClusterId) ?? new Set();
  const total = imageIdsOf(drawerClusterId).length;
  document.getElementById('drawer-meta').textContent = set.size + ' / ' + total + ' images selected';
}
function refreshDrawerIfOpen(clusterId) {
  if (drawerClusterId === clusterId) openDrawer(clusterId);
}

// ── Brand guidelines ──
async function saveBrand(e) {
  e.preventDefault();
  const text = document.getElementById('brand-text').value;
  const status = document.getElementById('brand-status');
  status.textContent = 'saving…';
  try {
    const r = await fetch('/workspace/' + encodeURIComponent(SLUG) + '/brand', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text })
    });
    if (!r.ok) throw new Error(await r.text());
    status.textContent = 'saved ✓';
    setTimeout(() => { status.textContent = ''; }, 1500);
  } catch (err) {
    status.textContent = 'error: ' + err.message;
  }
}

// ── Run regen ──
async function runRegen() {
  const items = [];
  for (const [cid, set] of selection.entries()) {
    if (set.size === 0) continue;
    items.push({ cluster_id: cid, image_ids: [...set] });
  }
  if (items.length === 0) return;
  // For v1 the CLI's --cluster-ids flag includes ALL images in the matched
  // clusters; per-image scoping requires a future flag. We pass cluster_ids
  // and document the gap inline for the user.
  const allFullySelected = items.every(it => it.image_ids.length === imageIdsOf(it.cluster_id).length);
  if (!allFullySelected) {
    if (!confirm('Some clusters have a partial image selection. The current regen runs on whole clusters — your unselected images in those clusters will also be regenerated. Proceed?')) return;
  }
  const fd = new FormData();
  fd.set('client', SLUG);
  for (const it of items) fd.append('cluster_id', it.cluster_id);
  fd.set('dry_run', document.getElementById('bar-dry-run').checked ? 'on' : '');
  fd.set('use_saved_token', document.getElementById('bar-saved-token').checked ? 'on' : '');
  const provider = document.getElementById('bar-provider').value;
  if (provider) fd.set('provider', provider);
  const r = await fetch('/regen', { method: 'POST', body: fd });
  if (r.redirected) { window.location.href = r.url; return; }
  const t = await r.text();
  alert(t || 'regen submitted');
}

refreshTotals();
</script>`;

  sendHtml(res, 200, shell(`workspace · ${slug}`, body, scripts, esc(slug)));
}

// ────────────────────────────────────────────────────────────────────────
// POST /workspace/:slug/brand — save brand guidelines
// ────────────────────────────────────────────────────────────────────────

async function saveBrandHandler(req: IncomingMessage, res: ServerResponse, slug: string) {
  if (!findClient(slug)) return sendJson(res, 400, { error: "unknown client" });
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let text = "";
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { text?: unknown };
    text = typeof body.text === "string" ? body.text : "";
  } catch {
    return sendJson(res, 400, { error: "invalid JSON body" });
  }
  const target = await saveBrandGuidelines(slug, text);
  sendJson(res, 200, { ok: true, path: target, length: text.length });
}

// ────────────────────────────────────────────────────────────────────────
// Regen subprocess + SSE — reused by both legacy /regen POST and run pages
// ────────────────────────────────────────────────────────────────────────

async function readBody(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  // Support both x-www-form-urlencoded and multipart/form-data (the
  // workspace fetch sends FormData; HTML form posts send urlencoded).
  const ct = req.headers["content-type"] ?? "";
  const raw = Buffer.concat(chunks).toString("utf8");
  if (ct.includes("multipart/form-data")) {
    return parseMultipart(raw, ct);
  }
  return new URLSearchParams(raw);
}

function parseMultipart(raw: string, contentType: string): URLSearchParams {
  // Minimal multipart parser sufficient for our text-only fields.
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  const out = new URLSearchParams();
  if (!boundary) return out;
  const sep = `--${boundary}`;
  for (const part of raw.split(sep)) {
    if (!part || part === "--" || part === "--\r\n") continue;
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headers = part.slice(0, headerEnd);
    const body = part.slice(headerEnd + 4).replace(/\r\n$/, "");
    const nameMatch = /name="([^"]+)"/.exec(headers);
    if (!nameMatch || !nameMatch[1]) continue;
    out.append(nameMatch[1], body);
  }
  return out;
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

  const proc = spawn("npx", args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: process.env });

  const state: RunState = {
    id, client: opts.client, args, startedAt: new Date().toISOString(),
    log: [], done: false, exitCode: null, proc, listeners: new Set(),
  };
  RUNS.set(id, state);

  const ondata = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    state.log.push(text);
    const csv = text.match(/regen: csv=(.+?)\n/);
    if (csv && csv[1]) state.csvPath = csv[1].trim();
    const html = text.match(/regen: html=(.+?)\n/);
    if (html && html[1]) state.htmlPath = html[1].trim();
    for (const l of state.listeners) l.write(`data: ${JSON.stringify({ text })}\n\n`);
  };
  proc.stdout?.on("data", ondata);
  proc.stderr?.on("data", ondata);
  proc.on("close", (code) => {
    state.done = true;
    state.exitCode = code;
    for (const l of state.listeners) {
      l.write(`event: end\ndata: ${JSON.stringify({ code, csvPath: state.csvPath, htmlPath: state.htmlPath })}\n\n`);
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
    sendHtml(res, 400, shell("Error", `<div class="banner err">No clusters selected.</div>`));
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
    .map((r) => `
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
</tr>`).join("");

  sendHtml(res, 200, shell("Runs", `
<section class="card">
  <h1>Runs <span style="color:var(--ink-faint);font-weight:400;font-size:14px">(this server session)</span></h1>
  <div class="sub">In-memory list of regen jobs spawned by this UI; cleared when the server restarts.</div>
</section>
<section class="card" style="padding:0">
${RUNS.size === 0
  ? `<div style="padding:24px;text-align:center;color:var(--ink-muted)">No runs yet. <a href="/">Start one →</a></div>`
  : `<table class="cluster-list"><thead><tr><th>id</th><th>client</th><th>started</th><th>status</th><th>output</th></tr></thead><tbody>${items}</tbody></table>`}
</section>`));
}

function runPage(res: ServerResponse, id: string) {
  const state = RUNS.get(id);
  if (!state) {
    sendHtml(res, 404, shell("Not found", `<div class="banner err">run ${esc(id)} not found</div>`));
    return;
  }
  const initial = esc(state.log.join(""));
  const cmd = esc(`npx ${state.args.join(" ")}`);

  sendHtml(res, 200, shell(`run ${id}`, `
<section class="card">
  <h1>Run <code>${esc(id)}</code></h1>
  <div class="sub">client <code>${esc(state.client)}</code> · started <code>${esc(state.startedAt)}</code></div>
  <details style="margin-top:8px">
    <summary class="sub">command</summary>
    <pre style="background:#f1f5f9;padding:8px 12px;border-radius:6px;font-size:12px;overflow:auto"><code>${cmd}</code></pre>
  </details>
</section>

<section class="card">
  <h2>Status</h2>
  <div id="status">
    ${state.done ? (state.exitCode === 0 ? `<div class="banner ok">finished, exit 0</div>` : `<div class="banner err">exited with code ${state.exitCode}</div>`) : `<div class="banner info">streaming…</div>`}
  </div>
  <div id="links" style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
    ${state.csvPath ? `<a class="btn" href="/files?p=${encodeURIComponent(state.csvPath)}">⬇ Download CSV</a>` : ""}
    ${state.htmlPath ? `<a class="btn primary" href="/files?p=${encodeURIComponent(state.htmlPath)}" target="_blank">Open HTML report ↗</a>` : ""}
    <a class="btn" href="/workspace/${esc(state.client)}">← back to workspace</a>
  </div>
</section>

<section class="card">
  <h2>Log</h2>
  <div id="log" class="log">${initial}</div>
</section>
`, `<script>
const logEl = document.getElementById('log');
const statusEl = document.getElementById('status');
const linksEl = document.getElementById('links');
${state.done ? "" : `
const es = new EventSource('/runs/${esc(id)}/events');
es.onmessage = (ev) => {
  try { const { text } = JSON.parse(ev.data); logEl.textContent += text; logEl.scrollTop = logEl.scrollHeight; } catch {}
};
es.addEventListener('end', (ev) => {
  const { code, csvPath, htmlPath } = JSON.parse(ev.data);
  statusEl.innerHTML = code === 0 ? '<div class="banner ok">finished, exit 0</div>' : '<div class="banner err">exited with code ' + code + '</div>';
  const links = [];
  if (csvPath) links.push('<a class="btn" href="/files?p=' + encodeURIComponent(csvPath) + '">⬇ Download CSV</a>');
  if (htmlPath) links.push('<a class="btn primary" href="/files?p=' + encodeURIComponent(htmlPath) + '" target="_blank">Open HTML report ↗</a>');
  links.push('<a class="btn" href="/workspace/${esc(state.client)}">← back to workspace</a>');
  linksEl.innerHTML = links.join(' ');
  es.close();
});
es.onerror = () => {};
`}
</script>`));
}

function runEvents(res: ServerResponse, id: string) {
  const state = RUNS.get(id);
  if (!state) { send(res, 404, "text/plain", "not found"); return; }
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(": connected\n\n");
  if (state.done) {
    res.write(`event: end\ndata: ${JSON.stringify({ code: state.exitCode, csvPath: state.csvPath, htmlPath: state.htmlPath })}\n\n`);
    res.end();
    return;
  }
  state.listeners.add(res);
  res.on("close", () => state.listeners.delete(res));
}

function serveFile(res: ServerResponse, fsPath: string) {
  const abs = path.resolve(fsPath);
  const root = path.resolve(process.cwd());
  if (!abs.startsWith(root)) { send(res, 400, "text/plain", "path outside project root"); return; }
  let stat;
  try { stat = statSync(abs); } catch { send(res, 404, "text/plain", "not found"); return; }
  const ext = path.extname(abs).toLowerCase();
  const types: Record<string, string> = {
    ".csv": "text/csv", ".html": "text/html; charset=utf-8", ".json": "application/json",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  };
  res.writeHead(200, { "content-type": types[ext] ?? "application/octet-stream", "content-length": String(stat.size) });
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

      const wsBrandMatch = /^\/workspace\/([^/]+)\/brand$/.exec(p);
      if (method === "POST" && wsBrandMatch && wsBrandMatch[1]) {
        return await saveBrandHandler(req, res, decodeURIComponent(wsBrandMatch[1]));
      }
      const wsMatch = /^\/workspace\/([^/]+)\/?$/.exec(p);
      if (method === "GET" && wsMatch && wsMatch[1]) {
        return await workspacePage(res, decodeURIComponent(wsMatch[1]));
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

      // Legacy /clusters?client=... → redirect to /workspace/<slug>
      if (method === "GET" && p === "/clusters") {
        const slug = url.searchParams.get("client") ?? "";
        if (slug) {
          res.writeHead(302, { location: `/workspace/${encodeURIComponent(slug)}` });
          res.end();
          return;
        }
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
