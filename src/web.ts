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
  listPublishedClusters,
  publishedClusterCountsByPageType,
  lookupProjectById,
  searchProjects,
  type ClusterRow,
  type ProjectRow,
  type PageType,
} from "./db.js";
import { collectImageRecords, type ImageRecord } from "./pageInfo.js";
import { loadEnv } from "./env.js";
import {
  loadBrandGuidelines,
  saveBrandGuidelines,
  loadToken,
  loadProjectOverrides,
  saveProjectOverrides,
} from "./tokens.js";
import { promises as fs } from "node:fs";
import { parse as csvParse } from "csv-parse/sync";
import { uploadBlogImage } from "./s3.js";

const LOGO_URL = "https://cdn.gushwork.ai/v2/gush_new_logo.svg";
const APP_TITLE = "Feeds Image Updater";

/**
 * Resolve a workspace URL "slug" to a `{ slug, projectId }` pair. The
 * slug is usually one of the allow-listed entries (e.g. `specgas`),
 * but the UI's live DB search lets the operator pick any project —
 * in that case the URL slug is the project_id (UUID) directly.
 * Returns null only if the input is neither in the allow-list nor a
 * valid UUID.
 */
function resolveClient(slug: string): { slug: string; projectId: string } | null {
  const entry = findClient(slug);
  if (entry) return entry;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slug)) {
    return { slug, projectId: slug };
  }
  return null;
}

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
  header.app .brand { display: flex; align-items: center; gap: 10px; color: var(--ink); text-decoration: none; }
  header.app .brand:hover { text-decoration: none; opacity: .85; }
  header.app img.logo { height: 22px; display: block; }
  header.app .title { font-size: 14px; font-weight: 600; letter-spacing: -.005em; color: var(--ink); }
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

  /* Client info card — nested details for graphic_token / company_info / etc. */
  .info-grid { display: grid; grid-template-columns: 200px 1fr; gap: 8px 16px; align-items: start; font-size: 13px; }
  .info-grid .k { color: var(--ink-muted); font-size: 12px; }
  .info-grid .v { word-break: break-word; }
  .json-dump { background: #f8fafc; border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; font: 11.5px/1.45 ui-monospace, Menlo, monospace; white-space: pre-wrap; max-height: 320px; overflow: auto; color: #334155; }

  /* Whole-row clickable cluster table */
  table.cluster-list tr.cluster-row { cursor: pointer; }
  table.cluster-list tr.cluster-row td { user-select: none; }
  table.cluster-list tr.cluster-row td.topic { user-select: text; }
  table.cluster-list td.topic { max-width: none; white-space: normal; overflow: visible; text-overflow: clip; }
  table.cluster-list td.topic .t { font-weight: 500; line-height: 1.4; word-break: break-word; }

  /* Toggle pill (used for test-run mode) */
  .toggle { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; color: var(--ink-muted); padding: 6px 10px; border: 1px solid var(--border); border-radius: 999px; background: #fff; }
  .toggle input { margin: 0; }
  .toggle.on { border-color: var(--brand); background: var(--accent-bg); color: var(--brand); }

  /* Combobox section headers + featured pill */
  .combobox .menu .opt-header { padding: 6px 12px; font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-muted); background: #f8fafc; border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 1; }
  .featured-pill { color: #b45309; font-size: 10px; vertical-align: middle; margin-left: 4px; }

  /* Per-cluster page_type pill (tiny, neutral) */
  .pill.pt-blog     { background: #dbeafe; color: #1e40af; padding: 0 6px; font-size: 10px; }
  .pill.pt-service  { background: #ede9fe; color: #5b21b6; padding: 0 6px; font-size: 10px; }
  .pill.pt-category { background: #fef3c7; color: #92400e; padding: 0 6px; font-size: 10px; }

  /* Page-type chooser modal */
  .pt-modal {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -52%) scale(.97);
    width: min(640px, 92vw); max-height: 80vh; overflow: hidden;
    background: #fff; border-radius: 14px; box-shadow: var(--shadow-lg);
    z-index: 81; display: flex; flex-direction: column;
    opacity: 0; pointer-events: none; transition: opacity .14s, transform .14s;
  }
  .pt-modal.open { opacity: 1; pointer-events: auto; transform: translate(-50%, -50%) scale(1); }
  .pt-modal .body { overflow-y: auto; flex: 1; }

  /* /import page-type chooser (legacy fallback page) */
  .pt-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
  .pt-row { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border: 1px solid var(--border-strong); border-radius: 10px; cursor: pointer; transition: border-color .15s, background .15s; background: #fff; }
  .pt-row:has(input:checked) { border-color: var(--brand); background: var(--accent-bg); }
  .pt-row.disabled { opacity: .5; cursor: not-allowed; }
  .pt-row input { width: 18px; height: 18px; }
  .pt-meta .pt-label { font-weight: 500; font-size: 14px; color: var(--ink); }
  .pt-meta .pt-count { font-size: 12px; color: var(--ink-muted); margin-top: 2px; }

  /* Page-type tabs (blog / service / category) */
  .page-tab-wrap { display: inline-flex; align-items: center; }
  .page-tab { display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 999px 0 0 999px; border: 1px solid var(--border); font-size: 12px; color: var(--ink-muted); background: #fff; text-decoration: none; }
  .page-tab:not(:has(+ .page-tab-x)) { border-radius: 999px; }
  .page-tab-wrap:not(:has(.page-tab-x)) .page-tab { border-radius: 999px; }
  .page-tab:hover { color: var(--ink); border-color: var(--border-strong); text-decoration: none; }
  .page-tab.active { background: var(--ink); color: #fff; border-color: var(--ink); }
  .page-tab .ct { font-size: 11px; opacity: .7; }
  .page-tab.active .ct { color: #cbd5e1; opacity: 1; }
  .page-tab-x { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border: 1px solid var(--border); border-left: none; border-radius: 0 999px 999px 0; color: var(--ink-faint); font-size: 14px; text-decoration: none; background: #fff; }
  .page-tab-x:hover { color: var(--err); border-color: #fca5a5; text-decoration: none; }

  /* Lightbox (image viewer) */
  .lightbox-overlay {
    position: fixed; inset: 0; background: rgba(15,23,42,.85);
    display: none; align-items: center; justify-content: center;
    z-index: 60; padding: 24px;
  }
  .lightbox-overlay.open { display: flex; }
  .lightbox-overlay img { max-width: min(1100px, 92vw); max-height: 86vh; border-radius: 8px; box-shadow: var(--shadow-lg); }
  .lightbox-overlay .close-x { position: fixed; top: 16px; right: 20px; background: rgba(255,255,255,.92); border: none; width: 36px; height: 36px; border-radius: 50%; font-size: 18px; cursor: pointer; box-shadow: var(--shadow); }
  .lightbox-overlay .caption { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); background: rgba(255,255,255,.92); padding: 8px 14px; border-radius: 6px; font-size: 12px; color: var(--ink); }

  /* Drawer warning block */
  .warn-block { background: #fef9c3; color: #713f12; border: 1px solid #fde68a; border-radius: 6px; padding: 10px 12px; font-size: 12.5px; margin: 10px 0; }
  .warn-block strong { color: #78350f; }

  /* Image card preview is now clickable. Hovering surfaces a "+"
     affordance in the corner so the operator knows it expands. */
  .img-card .pre { cursor: zoom-in; transition: outline-color .15s; outline: 2px solid transparent; position: relative; overflow: hidden; }
  .img-card .pre:hover { outline-color: var(--brand); }
  .img-card .pre::after,
  .result-card .rc-img::after {
    content: "+";
    position: absolute;
    top: 6px; right: 6px;
    width: 22px; height: 22px;
    border-radius: 50%;
    background: rgba(15,23,42,.6);
    color: #fff;
    font: 600 16px/22px -apple-system, system-ui, sans-serif;
    text-align: center;
    opacity: 0;
    transition: opacity .15s, transform .15s;
    pointer-events: none;
    z-index: 2;
  }
  .img-card .pre:hover::after,
  .result-card .rc-img:hover::after {
    opacity: 1;
    transform: scale(1.06);
  }
  .result-card .rc-img { position: relative; cursor: zoom-in; }
  .result-card .rc-img:hover img { filter: brightness(.94); }

  /* Run page result gallery */
  .rc-cluster-head { display: flex; align-items: start; gap: 14px; margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px solid var(--border); }
  .result-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
  .result-card { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; background: #fff; }
  .result-card .rc-img { background: #f1f5f9; aspect-ratio: 16/10; display: flex; align-items: center; justify-content: center; }
  .result-card .rc-img img { width: 100%; height: 100%; object-fit: cover; cursor: zoom-in; }
  .result-card .rc-img .ph { color: var(--ink-faint); font-size: 12px; }
  .result-card .rc-body { padding: 10px 12px 12px; }
  .result-card .rc-row { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
  .result-card .rc-id code { font-size: 10.5px; word-break: break-all; }
  .result-card .rc-desc { font-size: 12px; color: var(--ink-muted); margin-top: 6px; line-height: 1.45; }
  .result-card .err-line { background: var(--err-bg); color: var(--err); border-radius: 4px; padding: 4px 8px; margin-top: 6px; font-size: 11px; word-break: break-word; }
  .result-card .rc-actions { margin-top: 10px; display: flex; gap: 6px; }
  /* Run page result cards — only states we paint:
       pending  (default, no extra class)
       applying (in flight, blue tint)
       applied  (terminal success, green)
       failed   (apply or regen errored, red) */
  .result-card[data-state="applying"] { border-color: var(--brand); background: #eef2ff; }
  .result-card[data-state="applied"]  { border-color: var(--ok); background: #d1fae5; }
  .result-card[data-state="applied"] .btn-apply { background: var(--ok); border-color: var(--ok); color: #fff; }
  .result-card[data-state="failed"]   { border-color: #fca5a5; background: #fef2f2; }
  .result-card .rc-actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .result-card .rc-actions button { font-size: 12px; padding: 5px 10px; }
  .result-card .rc-status-line { font-size: 11px; color: var(--err); margin-top: 6px; display: none; }
  .result-card[data-synthetic="1"] .btn-apply { opacity: .5; }
  .result-card .state-pill { font-size: 10.5px; padding: 1px 8px; border-radius: 999px; font-weight: 500; }
  .result-card .state-pill.state-applying { background: var(--accent-bg); color: var(--brand); }
  .result-card .state-pill.state-applied  { background: var(--ok); color: #fff; }
  .result-card .state-pill.state-failed   { background: var(--err-bg); color: var(--err); }
  .result-card .state-pill.state-pending  { display: none; }

  /* Cluster section header on run page */
  .cluster-section .cs-head { display: flex; align-items: center; gap: 14px; margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px solid var(--border); }
  .cluster-section .cs-actions { margin-left: auto; display: flex; gap: 6px; }

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
  <a href="/" class="brand" title="Home">
    <img class="logo" src="${esc(LOGO_URL)}" alt="Gushwork">
    <span class="title">${esc(APP_TITLE)}</span>
  </a>${crumb ? `<span class="crumb">/ ${crumb}</span>` : ""}
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

/**
 * Encode a string for safe embedding inside an HTML double-quoted
 * attribute that the browser will then evaluate as JavaScript
 * (e.g. `onclick="…"`). Two passes: JSON.stringify gives a valid JS
 * string literal; esc() HTML-encodes the surrounding quotes so they
 * survive the HTML parse without truncating the attribute.
 *
 *   raw   = `cover · abc`
 *   step1 = JSON.stringify(raw)  → "cover · abc"
 *   step2 = esc(step1)           → &quot;cover · abc&quot;
 *   embed = `onclick="lbOpen(event, this.src, ${embed})"`
 *           → onclick="lbOpen(event, this.src, &quot;cover · abc&quot;)"
 *   browser decodes attribute   → lbOpen(event, this.src, "cover · abc")
 *   JS executes                  → lbOpen(event, this.src, "cover · abc")
 */
function jsAttr(v: string): string {
  return esc(JSON.stringify(v));
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

interface ClientPickerEntry {
  slug: string;
  projectId: string;
  name: string;
}

async function loadClientPickerEntries(): Promise<ClientPickerEntry[]> {
  // Fetch the project name for every allow-listed entry so the combobox
  // can search by name as well as slug / project_id. Done in parallel;
  // fast for any reasonable allow-list size.
  const out = await Promise.all(
    CLIENTS.map(async (c) => {
      try {
        const p = await lookupProjectById(c.projectId);
        return { slug: c.slug, projectId: c.projectId, name: p?.name ?? c.slug };
      } catch {
        return { slug: c.slug, projectId: c.projectId, name: c.slug };
      }
    }),
  );
  return out;
}

interface RecentRunSummary {
  manifest: string;
  client: string;
  client_name: string | null;
  project_id: string;
  started_at: string;
  finished_at: string | null;
  ok: number;
  failed: number;
  csv: string | null;
  html: string | null;
  run_id: string | null;
}

async function loadRecentRuns(limit = 6): Promise<RecentRunSummary[]> {
  const dir = path.resolve(process.cwd(), "out");
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const manifests = names.filter((n) => n.startsWith("manifest-") && n.endsWith(".json"));
  // Sort by name (timestamp suffix) descending so newest first.
  manifests.sort().reverse();
  const out: RecentRunSummary[] = [];
  for (const n of manifests.slice(0, limit)) {
    try {
      const raw = await fs.readFile(path.join(dir, n), "utf8");
      const j = JSON.parse(raw);
      const csvPath = typeof j.csv === "string" ? j.csv : null;
      const htmlPath = typeof j.html === "string" ? j.html : null;
      // run_id is the in-memory token; not in manifest, but the CSV
      // filename embeds <slug>-<utc-stamp>. Map that back to a stable id
      // — operators usually want the most recent run summary regardless.
      out.push({
        manifest: n,
        client: j.client ?? "",
        client_name: j.client_name ?? null,
        project_id: j.project_id ?? "",
        started_at: j.started_at ?? "",
        finished_at: j.finished_at ?? null,
        ok: j.summary?.ok ?? 0,
        failed: j.summary?.failed ?? 0,
        csv: csvPath,
        html: htmlPath,
        run_id: typeof j.run_id === "string" ? j.run_id : null,
      });
    } catch {
      /* skip corrupt manifest */
    }
  }
  return out;
}

async function homePage(res: ServerResponse) {
  let envOk = true;
  try {
    loadEnv();
  } catch {
    envOk = false;
  }
  const featured = envOk ? await loadClientPickerEntries() : CLIENTS.map((c) => ({ slug: c.slug, projectId: c.projectId, name: c.slug }));
  const featuredJson = JSON.stringify(featured);
  const recent = envOk ? await loadRecentRuns(6) : [];
  const recentRows = recent
    .map((r) => {
      const started = (r.started_at ?? "").slice(0, 19).replace("T", " ");
      const status = !r.finished_at
        ? `<span class="pill infographic">running</span>`
        : r.failed > 0
          ? `<span class="pill external">${r.failed} failed</span>`
          : `<span class="pill internal">${r.ok} ok</span>`;
      const linkable = r.run_id;
      const cellOpen = linkable
        ? `<a href="/runs/${esc(r.run_id!)}" style="display:contents;text-decoration:none;color:inherit">`
        : "";
      const cellClose = linkable ? `</a>` : "";
      return `
<tr class="recent-row" ${linkable ? `onclick="location='/runs/${esc(r.run_id!)}'" style="cursor:pointer"` : ""}>
  <td>${cellOpen}${esc(r.client_name ?? r.client)}${cellClose}</td>
  <td>${cellOpen}<code style="font-size:11px">${esc(started)}</code>${cellClose}</td>
  <td>${cellOpen}${status}${cellClose}</td>
  <td style="text-align:right">${linkable ? `<a href="/runs/${esc(r.run_id!)}">open run ↗</a>` : `${r.csv ? `<a href="/files?p=${encodeURIComponent(r.csv)}">CSV</a>` : ""}`}</td>
</tr>`;
    })
    .join("");

  sendHtml(res, 200, shell("Home", `
<section class="card">
  <h1 style="margin-bottom:0">${esc(APP_TITLE)}</h1>
</section>

<section class="card">
  <form id="import-form" onsubmit="onContinue(event)" autocomplete="off">
    <div class="row">
      <div style="flex:2">
        <div class="combobox" id="combo">
          <input type="text" id="client-input" placeholder="Search a client — name, URL, or project_id" autocomplete="off">
          <span class="arrow">▾</span>
          <div class="menu" id="combo-menu"></div>
        </div>
        <input type="hidden" id="client-slug">
        <input type="hidden" id="client-project-id">
      </div>
      <div style="flex:0 0 auto">
        <button class="primary" type="submit" id="import-btn" disabled>Continue →</button>
      </div>
    </div>
  </form>
</section>

${recent.length > 0 ? `
<section class="card" style="padding:0">
  <div style="padding:12px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center"><h2 style="margin:0">Recent runs</h2></div>
  <table class="cluster-list"><tbody>${recentRows}</tbody></table>
</section>` : ""}

<!-- Page-type chooser modal (opens on Continue) -->
<div class="drawer-overlay" id="pt-overlay" onclick="closePtModal(event)" style="z-index:80"></div>
<div id="pt-modal" class="pt-modal" role="dialog" aria-modal="true">
  <header style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">
    <h3 id="pt-title" style="margin:0;font-size:15px;font-weight:600;flex:1">Choose page types</h3>
    <button class="ghost" onclick="hidePtModal()">×</button>
  </header>
  <div class="body" style="padding:18px 20px">
    <div class="sub" style="margin-bottom:12px">Only published pages are loaded. Pick the types you want to work on; you can change this later.</div>
    <div id="pt-loading" class="sub">loading counts…</div>
    <div id="pt-grid" class="pt-grid" style="display:none"></div>
  </div>
  <footer style="padding:12px 20px;border-top:1px solid var(--border);display:flex;gap:10px;align-items:center">
    <span class="sub" id="pt-warn" style="color:var(--err);flex:1"></span>
    <button onclick="hidePtModal()">Cancel</button>
    <button class="primary" onclick="ptContinue()" id="pt-continue" disabled>Continue →</button>
  </footer>
</div>
`, `<script>
let lastSearchTimer = null;
let modalOpen = false;
async function searchProjects(q) {
  if (!q || q.length < 2) return [];
  try {
    const r = await fetch('/api/projects/search?q=' + encodeURIComponent(q));
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j.hits) ? j.hits : [];
  } catch { return []; }
}
async function onContinue(e) {
  e.preventDefault();
  if (!hidden.value || !hiddenPid.value) return;
  await openPtModal(hidden.value, hiddenPid.value, hiddenName.value || hidden.value);
}
const FEATURED = ${featuredJson};
const inp = document.getElementById('client-input');
const hidden = document.getElementById('client-slug');
const hiddenPid = document.getElementById('client-project-id');
const hiddenName = { value: '' };
const menu = document.getElementById('combo-menu');
const combo = document.getElementById('combo');
const btn = document.getElementById('import-btn');
let activeIdx = -1;
let visible = []; // unified list (featured + db results)

function renderMenu(featured, dbHits, q) {
  const items = [];
  if (featured.length > 0) {
    items.push({ kind: 'header', label: 'Featured (graphic_token pre-fetched)' });
    for (const c of featured) items.push({ kind: 'opt', name: c.name, slug: c.slug, projectId: c.projectId, featured: true });
  }
  if (dbHits.length > 0) {
    items.push({ kind: 'header', label: q ? 'Search results' : 'All projects' });
    for (const h of dbHits) items.push({ kind: 'opt', name: h.name ?? h.id, slug: '', projectId: h.id, url: h.url, featured: false });
  }
  visible = items.filter((x) => x.kind === 'opt');
  if (items.length === 0) {
    menu.innerHTML = '<div class="opt" style="color:var(--ink-faint);cursor:default">type to search across every project</div>';
    return;
  }
  let html = '';
  let optI = 0;
  for (const it of items) {
    if (it.kind === 'header') {
      html += '<div class="opt-header">' + it.label + '</div>';
    } else {
      const idx = optI++;
      html += '<div class="opt' + (idx === activeIdx ? ' active' : '') + '" data-i="' + idx + '">' +
        '<div><strong>' + (it.name || '(no name)') + '</strong>' + (it.featured ? ' <span class="featured-pill">★</span>' : '') + '</div>' +
        '<div class="pid">' + (it.slug ? it.slug + ' · ' : '') + it.projectId + (it.url ? ' · ' + it.url : '') + '</div>' +
      '</div>';
    }
  }
  menu.innerHTML = html;
}
function pick(i) {
  if (i < 0 || i >= visible.length) return;
  const c = visible[i];
  inp.value = c.name;
  hidden.value = c.slug || c.projectId; // slug for allow-list, project_id otherwise
  hiddenPid.value = c.projectId;
  hiddenName.value = c.name;
  combo.classList.remove('open');
  btn.disabled = false;
}
async function refresh(q) {
  const featuredHits = FEATURED.filter((c) => !q
    || c.name.toLowerCase().includes(q.toLowerCase())
    || c.slug.toLowerCase().includes(q.toLowerCase())
    || c.projectId.toLowerCase().includes(q.toLowerCase()));
  let dbHits = [];
  if (q && q.length >= 2) {
    dbHits = await searchProjects(q);
    // Drop duplicates already in featured.
    const featuredIds = new Set(FEATURED.map((c) => c.projectId));
    dbHits = dbHits.filter((h) => !featuredIds.has(h.id));
  }
  renderMenu(featuredHits, dbHits, q);
}
inp.addEventListener('focus', () => { refresh(inp.value); combo.classList.add('open'); });
inp.addEventListener('input', (e) => {
  hidden.value = ''; hiddenPid.value = ''; btn.disabled = true; activeIdx = -1;
  combo.classList.add('open');
  if (lastSearchTimer) clearTimeout(lastSearchTimer);
  lastSearchTimer = setTimeout(() => refresh(e.target.value), 200);
});
inp.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, visible.length - 1); refresh(inp.value); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); refresh(inp.value); }
  else if (e.key === 'Enter') { e.preventDefault(); if (activeIdx >= 0) pick(activeIdx); else if (visible.length === 1) pick(0); }
  else if (e.key === 'Escape') combo.classList.remove('open');
});
menu.addEventListener('mousedown', (e) => {
  const el = e.target.closest('.opt[data-i]');
  if (!el) return;
  e.preventDefault();
  pick(Number(el.dataset.i));
});
document.addEventListener('mousedown', (e) => {
  if (!combo.contains(e.target)) combo.classList.remove('open');
});

// ── Page-type chooser modal ──
async function openPtModal(slug, projectId, name) {
  modalOpen = true;
  document.getElementById('pt-title').textContent = 'Page types — ' + name;
  document.getElementById('pt-loading').style.display = 'block';
  document.getElementById('pt-grid').style.display = 'none';
  document.getElementById('pt-warn').textContent = '';
  document.getElementById('pt-modal').classList.add('open');
  document.getElementById('pt-overlay').classList.add('open');

  let counts = { blog: 0, service: 0, category: 0 };
  try {
    const r = await fetch('/api/page-type-counts?project_id=' + encodeURIComponent(projectId));
    const j = await r.json();
    if (j && j.counts) counts = j.counts;
  } catch {}
  const grid = document.getElementById('pt-grid');
  const cards = [
    { pt: 'blog',     label: 'Blog pages' },
    { pt: 'service',  label: 'Service pages' },
    { pt: 'category', label: 'Category pages' },
  ].map(({ pt, label }) => {
    const n = counts[pt] || 0;
    return '<label class="pt-row' + (n === 0 ? ' disabled' : '') + '">' +
      '<input type="checkbox" name="pt" value="' + pt + '" ' + (n > 0 ? 'checked' : 'disabled') + ' onchange="ptUpdate()">' +
      '<div class="pt-meta"><div class="pt-label">' + label + '</div>' +
      '<div class="pt-count">' + n + ' published</div></div>' +
    '</label>';
  }).join('');
  grid.innerHTML = cards;
  grid.dataset.slug = slug;
  document.getElementById('pt-loading').style.display = 'none';
  grid.style.display = 'grid';
  ptUpdate();
}
function ptUpdate() {
  const checks = document.querySelectorAll('#pt-grid input[name=pt]:checked');
  document.getElementById('pt-continue').disabled = checks.length === 0;
}
function ptContinue() {
  const checks = Array.from(document.querySelectorAll('#pt-grid input[name=pt]:checked')).map((c) => c.value);
  if (checks.length === 0) { document.getElementById('pt-warn').textContent = 'pick at least one'; return; }
  const slug = document.getElementById('pt-grid').dataset.slug;
  const params = new URLSearchParams();
  params.set('page_type', checks[0]);
  if (checks.length > 1) params.set('selected', checks.join(','));
  window.location.href = '/workspace/' + encodeURIComponent(slug) + '?' + params.toString();
}
function closePtModal(ev) { if (ev.target === ev.currentTarget) hidePtModal(); }
function hidePtModal() {
  modalOpen = false;
  document.getElementById('pt-modal').classList.remove('open');
  document.getElementById('pt-overlay').classList.remove('open');
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modalOpen) hidePtModal(); });

refresh('');
</script>`));
}

// ────────────────────────────────────────────────────────────────────────
// Workspace — cluster table + brand guidelines + drawer
// ────────────────────────────────────────────────────────────────────────

interface ClusterPayload {
  id: string;
  page_type: PageType;
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

/**
 * Page-type chooser shown immediately after the operator picks a client
 * on the home page. Three checkboxes (blog / service / category) all
 * default-checked; the page-type counts come from a single grouped
 * query so the operator can see what the client actually has before
 * committing to a load. Clicking Continue lands them in the workspace
 * for the first selected page_type, with the others available as tabs.
 */
async function importPage(res: ServerResponse, slug: string) {
  const entry = resolveClient(slug);
  if (!entry) {
    sendHtml(res, 400, shell("Error", `<div class="banner err">'${esc(slug)}' isn't a known slug or project_id.</div>`));
    return;
  }
  try {
    loadEnv();
  } catch (err) {
    sendHtml(res, 500, shell("Env error", `<div class="banner err">Env not configured: ${esc((err as Error).message)}</div>`));
    return;
  }

  let project: ProjectRow | null = null;
  let counts: Record<PageType, number> = { blog: 0, service: 0, category: 0 };
  try {
    project = await lookupProjectById(entry.projectId);
    if (!project) {
      sendHtml(res, 404, shell("Not found", `<div class="banner err">Project <code>${esc(entry.projectId)}</code> not found in DB.</div>`));
      return;
    }
    counts = await publishedClusterCountsByPageType(entry.projectId);
  } catch (err) {
    sendHtml(res, 500, shell("DB error", `<div class="banner err">DB query failed: ${esc((err as Error).message)}</div>`));
    return;
  }

  const row = (pt: PageType, label: string) => `
<label class="pt-row${counts[pt] === 0 ? " disabled" : ""}">
  <input type="checkbox" name="page_type" value="${pt}" ${counts[pt] > 0 ? "checked" : "disabled"}>
  <div class="pt-meta">
    <div class="pt-label">${label}</div>
    <div class="pt-count">${counts[pt]} published cluster${counts[pt] === 1 ? "" : "s"}</div>
  </div>
</label>`;

  sendHtml(res, 200, shell(`Choose page types · ${slug}`, `
<section class="card">
  <div class="sub" style="margin-bottom:6px"><a href="/" style="color:var(--ink-muted)">← Home</a></div>
  <h1>${esc(project.name ?? slug)}</h1>
  <div class="sub">Choose which page types to load. Only <code>page_status = 'PUBLISHED'</code> clusters are surfaced; counts below are live from the DB.</div>
</section>

<section class="card">
  <h2>Page types</h2>
  <form method="get" action="/workspace/${esc(slug)}" onsubmit="return go(event)">
    <div class="pt-grid">
      ${row("blog", "Blog pages")}
      ${row("service", "Service pages")}
      ${row("category", "Category pages")}
    </div>
    <div style="display:flex;gap:8px;margin-top:14px;align-items:center">
      <button class="primary" type="submit">Continue →</button>
      <a class="btn" href="/">Cancel</a>
      <span id="warn" class="sub" style="color:var(--err)"></span>
    </div>
  </form>
</section>
`, `<script>
function go(e) {
  e.preventDefault();
  const checks = Array.from(document.querySelectorAll('input[name=page_type]:checked')).map(c => c.value);
  if (checks.length === 0) { document.getElementById('warn').textContent = 'pick at least one page type'; return false; }
  // Workspace honours one page_type at a time today; stash the rest as a
  // selected= URL param so the in-workspace tabs only show the chosen ones.
  const first = checks[0];
  const params = new URLSearchParams();
  params.set('page_type', first);
  if (checks.length > 1) params.set('selected', checks.join(','));
  window.location.href = '/workspace/${esc(slug)}?' + params.toString();
  return false;
}
</script>`));
}

async function workspacePage(
  res: ServerResponse,
  slug: string,
  pageType: PageType = "blog",
  selectedPageTypes?: Set<PageType>,
) {
  const entry = resolveClient(slug);
  if (!entry) {
    sendHtml(res, 400, shell("Error", `<div class="banner err">'${esc(slug)}' isn't a known slug or project_id.</div>`));
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
  let pageTypeCounts: Record<PageType, number> = { blog: 0, service: 0, category: 0 };
  try {
    project = await lookupProjectById(entry.projectId);
    if (!project) {
      sendHtml(res, 404, shell("Not found", `<div class="banner err">Project <code>${esc(entry.projectId)}</code> not found in DB.</div>`));
      return;
    }
    // Multi-page-type rendering: when the operator picked >1 page type
    // in the modal, query all of them in a single SQL and render the
    // combined list. The active "tab" is now just a hint for which to
    // visually highlight; the cluster list shows everything in the
    // selected set, with a per-row page_type pill.
    const queryTypes: PageType[] = selectedPageTypes && selectedPageTypes.size > 0
      ? [...selectedPageTypes]
      : [pageType];
    [clusters, pageTypeCounts] = await Promise.all([
      listPublishedClusters(entry.projectId, queryTypes),
      publishedClusterCountsByPageType(entry.projectId),
    ]);
  } catch (err) {
    sendHtml(res, 500, shell("DB error", `<div class="banner err">DB query failed: ${esc((err as Error).message)}</div>`));
    return;
  }

  const brand = (await loadBrandGuidelines(slug)) ?? "";
  const savedToken = await loadToken(slug);
  const overrides = await loadProjectOverrides(slug);

  // If AWS creds aren't set on this deployment we can't fetch the
  // blog_with_image_placeholders.md from S3 — the parser would throw
  // 57 times and silently fall back to cover/thumbnail only. Detect
  // up front so the workspace can surface a clear banner instead of
  // looking like the data is just missing.
  const env = loadEnv();
  const hasAwsCreds = Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);

  // Parallel S3 fetches for inline-image counts.
  const s3Cache = new Map<string, string | null>();
  const stagingSubdomain = hasAwsCreds ? project.staging_subdomain : null;
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
    const cover = recs.find((r) => r.asset === "cover" || r.asset === "service_h1" || r.asset === "category_industry");
    return {
      id: c.id,
      page_type: c.page_type,
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

  // Render cluster rows. Whole row is clickable; the master checkbox
  // sits inside but stops event propagation so its click doesn't open
  // the drawer (and vice versa).
  const tbody = payload
    .map((c) => {
      const cover = c.cover_url
        ? `<img src="${esc(c.cover_url)}" alt="" loading="lazy">`
        : `<div class="placeholder"></div>`;
      const pills = Object.entries(c.by_asset)
        .map(([k, v]) => `<span class="pill ${esc(k)}">${esc(k)}: ${v}</span>`)
        .join(" ");
      return `
<tr class="cluster-row" data-cluster-id="${esc(c.id)}" data-page-type="${esc(c.page_type)}" data-topic="${esc(c.topic.toLowerCase())}" onclick="rowClick(event, '${esc(c.id)}')">
  <td onclick="event.stopPropagation()"><input type="checkbox" class="cluster-select" data-cluster-id="${esc(c.id)}" onclick="onClusterCheck('${esc(c.id)}', this.checked, event)"></td>
  <td class="topic">
    <div class="t">${esc(c.topic)}</div>
    <div class="cid"><span class="pill pt-${esc(c.page_type)}">${esc(c.page_type)}</span> <code>${esc(c.id)}</code> · ${esc(c.updated_at ?? "")}</div>
  </td>
  <td class="preview">${cover}</td>
  <td class="types"><div class="pills-wrap">${pills}</div></td>
  <td style="text-align:right;color:var(--ink-faint);font-size:11px">click to open ↗</td>
</tr>`;
    })
    .join("");

  // Pre-render Client info card
  function fmtJson(v: unknown): string {
    if (v == null) return "(empty)";
    try { return JSON.stringify(v, null, 2); } catch { return String(v); }
  }
  const logoUrls = (project.logo_urls ?? null) as Record<string, unknown> | null;
  const primaryLogo =
    (logoUrls && typeof logoUrls === "object"
      ? (logoUrls.primary_logo ??
         logoUrls.logo ??
         logoUrls.primaryLogo ??
         Object.values(logoUrls).find((v) => typeof v === "string" && (v as string).startsWith("http")))
      : null) as string | null | undefined;

  const awsBanner = hasAwsCreds
    ? ""
    : `
<section class="card" style="border-color:#fde68a;background:#fef9c3">
  <div style="display:flex;align-items:start;gap:10px;font-size:13px;color:#713f12">
    <span style="font-size:18px;line-height:1">⚠</span>
    <div>
      <strong>AWS credentials are not set on this deployment.</strong>
      Inline images (infographic / internal / external / generic) live in
      <code>s3://${esc(env.S3_BUCKET ?? "gw-stormbreaker")}/page_data/&lt;staging&gt;/blog/&lt;cluster&gt;/output/blog_with_image_placeholders.md</code>
      and can't be fetched without keys — only cover + thumbnail are surfaced.
      Apply-to-S3 also won't work.
      <br>Set <code>AWS_ACCESS_KEY_ID</code> and <code>AWS_SECRET_ACCESS_KEY</code> in your service variables (Railway → Service → Variables) and redeploy.
    </div>
  </div>
</section>`;

  const effectiveLogo = overrides.logo_url || primaryLogo || "";
  // Workspace tabs reflect ONLY the page types the operator picked at
  // /import. If they unchecked Service or Category there, those tabs
  // don't render here. Default = show all three (legacy direct hits).
  const visibleTabs: PageType[] = selectedPageTypes && selectedPageTypes.size > 0
    ? (["blog", "service", "category"] as PageType[]).filter((pt) => selectedPageTypes.has(pt))
    : ["blog", "service", "category"];
  const selectedQs = selectedPageTypes && selectedPageTypes.size > 0
    ? `&selected=${[...selectedPageTypes].join(",")}`
    : "";
  const tabHref = (pt: PageType) => `/workspace/${esc(slug)}?page_type=${pt}${selectedQs}`;
  // Each tab has a small × that drops it from the selected set; clicking
  // the tab itself navigates to that page_type's view. The current
  // active tab can't be removed (would leave an empty selection).
  const tabBtn = (pt: PageType, label: string) => {
    const isActive = pageType === pt;
    const closeable = !isActive;
    const dropQs = (() => {
      if (!selectedPageTypes || selectedPageTypes.size <= 1) return "";
      const remaining = [...visibleTabs].filter((t) => t !== pt).join(",");
      return remaining ? `?page_type=${pageType}&selected=${remaining}` : `?page_type=${pageType}`;
    })();
    return `<span class="page-tab-wrap">
      <a class="page-tab${isActive ? " active" : ""}" href="${tabHref(pt)}">${label} <span class="ct">${pageTypeCounts[pt]}</span></a>
      ${closeable && selectedPageTypes && selectedPageTypes.size > 1 ? `<a class="page-tab-x" href="/workspace/${esc(slug)}${dropQs}" title="remove from selection">×</a>` : ""}
    </span>`;
  };

  const body = `
${awsBanner}
<section class="card">
  <div style="display:flex;align-items:start;gap:16px">
    ${effectiveLogo ? `<img src="${esc(effectiveLogo)}" alt="logo" style="width:48px;height:48px;border-radius:6px;object-fit:contain;background:#fff;border:1px solid var(--border);padding:4px;flex:0 0 auto">` : ""}
    <div style="flex:1">
      <h1>${esc(project.name ?? slug)}</h1>
      <div class="sub">
        ${clusters.length} ${esc(pageType)} pages · ${totalImages} images (${totalsBadges})
      </div>
      <div class="page-tabs" style="margin-top:10px;display:flex;gap:6px">
        ${visibleTabs.map((pt) => tabBtn(pt, pt[0]!.toUpperCase() + pt.slice(1))).join("")}
        <a class="page-tab" href="/import?client=${esc(slug)}" style="margin-left:auto;color:var(--ink-muted)">⇅ Change selection</a>
      </div>
    </div>
    <label class="toggle" id="test-run-toggle" style="flex:0 0 auto">
      <input type="checkbox" id="test-run-mode" onchange="toggleTestRun(this.checked)">
      Test run mode (3 clusters)
    </label>
  </div>
</section>

<section class="card">
  <details>
    <summary><h2 style="display:inline">Client information</h2></summary>
    <div class="sub" style="margin:8px 0 14px">Logo + graphic_token are the only inputs the regen pipeline reads. Everything else is just shown for context.</div>

    <!-- Logo: real preview + URL override + Save (auto-refreshes the
         preview on success so the operator sees the override take). -->
    <div style="display:flex;gap:14px;align-items:center;margin-bottom:14px">
      <div id="logo-preview-wrap">
        ${effectiveLogo
          ? `<img id="logo-preview" src="${esc(effectiveLogo)}" alt="logo" style="width:72px;height:72px;border-radius:8px;object-fit:contain;background:#fff;border:1px solid var(--border);padding:6px">`
          : `<div id="logo-preview" style="width:72px;height:72px;border-radius:8px;background:#f8fafc;border:1px dashed var(--border-strong);display:flex;align-items:center;justify-content:center;color:var(--ink-faint);font-size:11px">no logo</div>`}
      </div>
      <form id="logo-form" onsubmit="saveLogo(event)" style="flex:1">
        <label style="font-size:12px;color:var(--ink-muted)">Logo URL (overrides the project's primary_logo)</label>
        <div style="display:flex;gap:8px;margin-top:4px">
          <input type="text" id="logo-url-input" placeholder="https://…/logo.png" value="${esc(overrides.logo_url ?? "")}" style="flex:1">
          <button class="primary" type="submit">Save</button>
        </div>
        <span id="logo-status" class="sub" style="margin-top:4px;display:inline-block"></span>
      </form>
    </div>

    <div class="info-grid">
      <div class="k">name</div>           <div class="v">${esc(project.name ?? "—")}</div>
      <div class="k">homepage url</div>   <div class="v">${project.url ? `<a href="${esc(project.url)}" target="_blank" rel="noopener">${esc(project.url)}</a>` : "—"}</div>
    </div>
  </details>
</section>

<section class="card">
  <details>
    <summary>
      <h2 style="display:inline">Brand guidelines · graphic_token</h2>
    </summary>
    <div class="sub" style="margin:8px 0 10px">
      The graphic_token JSON below is what the prompts read. To add brand guidelines (colors not in the token, mandatory taglines, things to avoid, etc.), type them in the box at the bottom and click <strong>Save</strong> — they're appended to the token under <code>additional_instructions</code> and become part of every prompt going forward.
    </div>

    <details style="margin-bottom:12px">
      <summary><strong style="font-size:13px">graphic_token (read-only view)</strong></summary>
      <pre class="json-dump" style="margin-top:8px">${esc(fmtJson(savedToken))}</pre>
    </details>

    <form id="brand-form" onsubmit="saveBrand(event)">
      <label style="font-size:12px;color:var(--ink-muted)">Append to <code>graphic_token.additional_instructions</code></label>
      <textarea id="brand-text" style="margin-top:4px" placeholder="(optional) e.g. Use deep navy + gold only. Avoid stock-photo people. Always include the brand mark in the footer.">${esc(brand)}</textarea>
      <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
        <button type="submit" class="primary">Save</button>
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
        <th style="width:120px;text-align:right"></th>
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
    <button class="primary" onclick="closeDrawer()">Done</button>
  </footer>
</aside>

<!-- Lightbox -->
<div class="lightbox-overlay" id="lightbox" onclick="closeLightboxOnBackdrop(event)">
  <button class="close-x" onclick="closeLightbox()" aria-label="Close">×</button>
  <img id="lightbox-img" src="" alt="">
  <div class="caption" id="lightbox-cap"></div>
</div>

<!-- Sticky bottom action bar.
     Live "Generate selected" is intentionally hidden during platform
     verification; the only available action is the Dry run, which
     mocks the full pipeline (no Portkey / Replicate spend) and
     produces dummy outputs so the publish flow can be validated. -->
<div class="action-bar">
  <div class="stats">
    <strong id="bar-img-count">0</strong> images selected across <strong id="bar-cluster-count">0</strong> clusters
    <span id="bar-test-mode" style="display:none;color:var(--brand);margin-left:10px;font-size:12px">· test-run mode active (3 clusters)</span>
    <span style="color:var(--ink-faint);margin-left:10px;font-size:12px">· live generation disabled while platform is in verification</span>
  </div>
  <div class="right">
    <button class="primary" id="bar-dry-run-btn" onclick="runRegen(true)" disabled title="Mock the whole pipeline: skips Portkey + Replicate, emits synthetic prompts and picsum.photos URLs so the publish flow can be reviewed in seconds.">Dry run →</button>
  </div>
</div>
`;

  const scripts = `<script>
const SLUG = ${JSON.stringify(slug)};
const PAGE_TYPE = ${JSON.stringify(pageType)};
const CLUSTERS = ${JSON.stringify(payload)};
const TEST_RUN_LIMIT = 3;
// Per-cluster set of selected image IDs. Empty set = nothing selected.
const selection = new Map();

function imageIdsOf(clusterId) {
  const c = CLUSTERS.find(x => x.id === clusterId);
  return c ? c.images.map(i => i.id) : [];
}
function clusterById(id) { return CLUSTERS.find(c => c.id === id); }

// Track the last-clicked cluster checkbox so shift-click extends a range.
let lastClickedClusterId = null;
function onClusterCheck(clusterId, on, ev) {
  // Shift-click range select: tick (or untick) every visible row between
  // the previous click and this one.
  if (ev && ev.shiftKey && lastClickedClusterId && lastClickedClusterId !== clusterId) {
    const visibleIds = visibleRows().map((tr) => tr.dataset.clusterId).filter(Boolean);
    const a = visibleIds.indexOf(lastClickedClusterId);
    const b = visibleIds.indexOf(clusterId);
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      for (let i = lo; i <= hi; i++) {
        const cid = visibleIds[i];
        if (on) selection.set(cid, new Set(imageIdsOf(cid)));
        else selection.delete(cid);
      }
      refreshTotals();
      lastClickedClusterId = clusterId;
      return;
    }
  }
  if (on) selection.set(clusterId, new Set(imageIdsOf(clusterId)));
  else selection.delete(clusterId);
  lastClickedClusterId = clusterId;
  refreshTotals();
  refreshDrawerIfOpen(clusterId);
}
function toggleAllClusters(on) {
  for (const tr of visibleRows()) {
    const cid = tr.dataset.clusterId;
    if (!cid) continue;
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

// ── Test run mode (limit to first 3 clusters) ──
let testRunMode = false;
function toggleTestRun(on) {
  testRunMode = on;
  document.getElementById('test-run-toggle').classList.toggle('on', on);
  document.getElementById('bar-test-mode').style.display = on ? 'inline' : 'none';
  applyFilters();
}
function applyFilters() {
  const q = (document.getElementById('topic-filter').value || '').toLowerCase().trim();
  let n = 0;
  let matchedSoFar = 0;
  for (const tr of allRows()) {
    const topic = tr.dataset.topic ?? '';
    const cid = tr.dataset.clusterId ?? '';
    const matchSearch = !q || topic.includes(q) || cid.includes(q);
    let visible = matchSearch;
    if (visible && testRunMode) {
      if (matchedSoFar >= TEST_RUN_LIMIT) visible = false;
      else matchedSoFar++;
    }
    tr.classList.toggle('row-hidden', !visible);
    if (visible) n++;
  }
  document.getElementById('visible-count').textContent = n;
  document.getElementById('all-clusters').checked = false;
}
function filterClusters() { applyFilters(); }

function refreshTotals() {
  let imgs = 0, cls = 0;
  for (const [cid, set] of selection.entries()) {
    if (set.size > 0) { cls++; imgs += set.size; }
  }
  document.getElementById('bar-img-count').textContent = imgs;
  document.getElementById('bar-cluster-count').textContent = cls;
  document.getElementById('bar-dry-run-btn').disabled = imgs === 0;
  for (const tr of allRows()) {
    const cid = tr.dataset.clusterId;
    if (!cid) continue;
    const cb = tr.querySelector('input.cluster-select');
    if (!cb) continue;
    const set = selection.get(cid);
    const total = imageIdsOf(cid).length;
    if (!set || set.size === 0) { cb.checked = false; cb.indeterminate = false; }
    else if (set.size === total) { cb.checked = true; cb.indeterminate = false; }
    else { cb.checked = false; cb.indeterminate = true; }
  }
}

// ── Whole-row click → open drawer ──
function rowClick(ev, cid) {
  // ignore clicks that originated on a checkbox / interactive element
  const t = ev.target;
  if (t.closest('input,button,a,label,code')) return;
  openDrawer(cid);
}

// ── Drawer ──
let drawerClusterId = null;
function openDrawer(cid) {
  const c = clusterById(cid);
  if (!c) return;
  drawerClusterId = cid;
  const set = selection.get(cid) ?? new Set();
  document.getElementById('drawer-title').textContent = c.topic;

  const cardsHtml = [];
  let warnedComplexFlow = false;
  for (const img of c.images) {
    const isComplex = (img.asset === 'internal' || img.asset === 'external');
    if (isComplex && !warnedComplexFlow) {
      cardsHtml.push(
        '<div class="warn-block"><strong>Heads-up:</strong> the <code>internal</code> / <code>external</code> image flow is complicated — only choose these if particularly necessary. Cover, thumbnail and infographic flows are the well-trodden paths.</div>'
      );
      warnedComplexFlow = true;
    }
    const checked = set.has(img.id);
    // Only cover / thumbnail have a real preview URL we can show right
    // now (sourced from page_info.thumbnail). For inline / service /
    // category images the per-image URL needs a UUID→S3-hash mapping
    // table that we haven't fully wired up yet — show a clean
    // placeholder that explains it, rather than reusing the cover and
    // making every card look identical.
    const previewSrc = img.preview_url || '';
    const captionAttr = JSON.stringify(img.asset + ' · ' + img.id).replace(/"/g, '&quot;');
    const placeholderText = (img.asset === 'cover' || img.asset === 'thumbnail')
      ? 'no preview'
      : 'preview after generation';
    const previewHtml = previewSrc
      ? '<img src="' + previewSrc + '" alt="" loading="lazy" onclick="openLightbox(event, this.src, ' + captionAttr + ')">'
      : '<div class="ph">' + placeholderText + '</div>';
    cardsHtml.push(
      '<label class="img-card' + (checked ? ' selected' : '') + '" data-img-id="' + img.id + '">' +
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
      '</label>'
    );
  }

  document.getElementById('drawer-body').innerHTML =
    '<div class="desc-cluster">cluster <code>' + c.id + '</code> · ' + c.total + ' images · last updated ' + (c.updated_at ?? '') + '</div>' +
    cardsHtml.join('');
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

// ── Lightbox ──
function openLightbox(ev, src, caption) {
  if (ev) ev.stopPropagation();
  const lb = document.getElementById('lightbox');
  document.getElementById('lightbox-img').src = src;
  document.getElementById('lightbox-cap').textContent = caption || '';
  lb.classList.add('open');
}
function closeLightbox() {
  document.getElementById('lightbox').classList.remove('open');
  document.getElementById('lightbox-img').src = '';
}
function closeLightboxOnBackdrop(ev) {
  // Close only if user clicked backdrop, not the image itself.
  if (ev.target === ev.currentTarget) closeLightbox();
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (document.getElementById('lightbox').classList.contains('open')) { closeLightbox(); return; }
    if (document.getElementById('drawer').classList.contains('open')) closeDrawer();
  }
});

// ── Logo URL override (auto-refreshes preview on save) ──
async function saveLogo(e) {
  e.preventDefault();
  const url = document.getElementById('logo-url-input').value.trim();
  const status = document.getElementById('logo-status');
  status.textContent = 'saving…';
  try {
    const r = await fetch('/workspace/' + encodeURIComponent(SLUG) + '/logo', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ logo_url: url })
    });
    if (!r.ok) throw new Error(await r.text());
    const j = await r.json();
    // Hot-swap the preview so the operator sees the override apply.
    const wrap = document.getElementById('logo-preview-wrap');
    const newSrc = j.effective_logo || '';
    if (newSrc) {
      wrap.innerHTML = '<img id="logo-preview" src="' + newSrc + '?_=' + Date.now() + '" alt="logo" style="width:72px;height:72px;border-radius:8px;object-fit:contain;background:#fff;border:1px solid var(--border);padding:6px">';
    } else {
      wrap.innerHTML = '<div id="logo-preview" style="width:72px;height:72px;border-radius:8px;background:#f8fafc;border:1px dashed var(--border-strong);display:flex;align-items:center;justify-content:center;color:var(--ink-faint);font-size:11px">no logo</div>';
    }
    status.textContent = url ? 'saved ✓ override active' : 'saved ✓ (using project default)';
    setTimeout(() => { status.textContent = ''; }, 2200);
  } catch (err) {
    status.textContent = 'error: ' + err.message;
  }
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

// Dry-run today is a full mock: skips Portkey + Replicate, emits
// synthetic prompts + picsum.photos URLs. Live generation is wired in
// the CLI but disabled in the UI until the platform is verified.
async function runRegen(_unused) {
  const items = [];
  for (const [cid, set] of selection.entries()) {
    if (set.size === 0) continue;
    items.push({ cluster_id: cid, image_ids: [...set] });
  }
  if (items.length === 0) return;

  const fd = new FormData();
  fd.set('client', SLUG);
  fd.set('page_type', PAGE_TYPE);
  for (const it of items) {
    fd.append('cluster_id', it.cluster_id);
    for (const id of it.image_ids) fd.append('image_id', id);
  }
  fd.set('mock', 'on');
  fd.set('provider', 'replicate');
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

async function applyOneHandler(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let runId = "", imageId = "", imageUrl: string | null = null;
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
      run_id?: string;
      image_id?: string;
      image_url?: string;
    };
    runId = body.run_id ?? "";
    imageId = body.image_id ?? "";
    imageUrl = body.image_url ?? null;
  } catch {
    return sendJson(res, 400, { error: "invalid JSON body" });
  }
  if (!runId || !imageId) return sendJson(res, 400, { error: "run_id and image_id required" });

  const state = RUNS.get(runId);
  if (!state) return sendJson(res, 404, { error: `run ${runId} not found` });
  if (!state.csvPath) return sendJson(res, 400, { error: "run has no CSV yet" });

  // Load the CSV row for this image to recover image_url_new + cluster_id
  // (when the client didn't pass image_url explicitly, e.g. after regen-one
  // updated the in-page src but not the CSV).
  let clusterId = "";
  if (!imageUrl) {
    const rows = await readRunCsv(state.csvPath);
    const row = rows.find((r) => r.image_id === imageId);
    if (!row) return sendJson(res, 404, { error: `image_id ${imageId} not in run CSV` });
    if (!row.image_url_new) return sendJson(res, 400, { error: `no new image URL for ${imageId}` });
    imageUrl = row.image_url_new;
    clusterId = row.cluster_id;
  } else {
    // We still need cluster_id; find via CSV.
    const rows = await readRunCsv(state.csvPath);
    const row = rows.find((r) => r.image_id === imageId);
    if (!row) return sendJson(res, 404, { error: `image_id ${imageId} not in run CSV` });
    clusterId = row.cluster_id;
  }

  // Synthetic cover/thumbnail IDs aren't real S3 paths — refuse for now.
  if (imageId.includes("/")) {
    return sendJson(res, 400, {
      error:
        `Apply not yet supported for synthetic image_ids (e.g. cover-images/, thumbnail-images/). ` +
        `These don't map 1:1 to existing S3 keys; cover/thumbnail wiring is the next iteration.`,
    });
  }

  // Look up the project to get staging_subdomain.
  const entry = findClient(state.client);
  if (!entry) return sendJson(res, 400, { error: `client ${state.client} not in allow-list` });
  const project = await lookupProjectById(entry.projectId);
  if (!project?.staging_subdomain) {
    return sendJson(res, 500, { error: "project missing staging_subdomain" });
  }

  try {
    const result = await uploadBlogImage({
      stagingSubdomain: project.staging_subdomain,
      clusterId,
      imageId,
      imageUrl: imageUrl!,
    });
    sendJson(res, 200, { ok: true, ...result, image_id: imageId, cluster_id: clusterId });
  } catch (err) {
    sendJson(res, 500, { error: (err as Error).message });
  }
}

async function regenOneHandler(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let imageId = "", clusterId = "";
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { image_id?: string; cluster_id?: string };
    imageId = body.image_id ?? "";
    clusterId = body.cluster_id ?? "";
  } catch {
    return sendJson(res, 400, { error: "invalid JSON body" });
  }
  if (!imageId) return sendJson(res, 400, { error: "image_id required" });
  // Mock: rotate the picsum seed so the operator sees a different
  // image after Regenerate. The live wiring would kick off a single-
  // image CLI subprocess and return its image_url_new from the CSV.
  const seed = (imageId + "-" + Date.now()).replace(/[^a-zA-Z0-9]/g, "").slice(0, 40);
  const url = `https://picsum.photos/seed/${seed}/800/450`;
  sendJson(res, 200, { image_url_new: url, mock: true, image_id: imageId, cluster_id: clusterId });
}

async function saveBrandHandler(req: IncomingMessage, res: ServerResponse, slug: string) {
  if (!resolveClient(slug)) return sendJson(res, 400, { error: "unknown client" });
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let text = "";
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { text?: unknown };
    text = typeof body.text === "string" ? body.text : "";
  } catch {
    return sendJson(res, 400, { error: "invalid JSON body" });
  }
  const trimmed = (text ?? "").trim();

  // Two writes:
  //  1) Mutate graphic-tokens/<slug>.json so prompts that already
  //     interpolate {{graphic_token}} pick this up via
  //     graphic_token.additional_instructions — the user's spec.
  //  2) Keep saving the raw text to graphic-tokens/<slug>-brand.txt
  //     so the existing regen pipeline (which reads brand guidelines
  //     out of that file and merges into business_context) still
  //     works without code changes elsewhere.
  let tokenPath: string | null = null;
  try {
    const token = (await loadToken(slug)) ?? {};
    if (trimmed) (token as Record<string, unknown>).additional_instructions = trimmed;
    else delete (token as Record<string, unknown>).additional_instructions;
    const { saveToken } = await import("./tokens.js");
    tokenPath = await saveToken(slug, token);
  } catch (err) {
    process.stderr.write(`saveBrand: graphic_token append failed: ${(err as Error).message}\n`);
  }
  const brandPath = await saveBrandGuidelines(slug, trimmed);

  sendJson(res, 200, { ok: true, brand_path: brandPath, token_path: tokenPath, length: trimmed.length });
}

async function saveLogoHandler(req: IncomingMessage, res: ServerResponse, slug: string) {
  if (!resolveClient(slug)) return sendJson(res, 400, { error: "unknown client" });
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let logo_url = "";
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { logo_url?: unknown };
    logo_url = typeof body.logo_url === "string" ? body.logo_url.trim() : "";
  } catch {
    return sendJson(res, 400, { error: "invalid JSON body" });
  }
  if (logo_url && !/^https?:\/\//.test(logo_url)) {
    return sendJson(res, 400, { error: "logo_url must start with http(s)://" });
  }
  const target = await saveProjectOverrides(slug, { logo_url: logo_url || undefined });

  // Compute the effective logo so the client can hot-swap the preview.
  let effective: string | null = logo_url || null;
  if (!effective) {
    const entry = resolveClient(slug);
    if (entry) {
      const project = await lookupProjectById(entry.projectId);
      const lu = project?.logo_urls as Record<string, unknown> | null;
      if (lu && typeof lu === "object") {
        for (const k of ["primary_logo", "logo", "primaryLogo"]) {
          const v = lu[k];
          if (typeof v === "string" && v.startsWith("http")) { effective = v; break; }
        }
        if (!effective) {
          for (const v of Object.values(lu)) {
            if (typeof v === "string" && v.startsWith("http")) { effective = v; break; }
          }
        }
      }
    }
  }
  sendJson(res, 200, { ok: true, path: target, logo_url, effective_logo: effective });
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
  imageIds: string[];
  dryRun: boolean;
  mock: boolean;
  useSavedToken: boolean;
  assetTypes?: string;
  pageType?: PageType;
  provider?: string;
}): RunState {
  const id = randomUUID().slice(0, 8);
  const args = ["tsx", "src/cli.ts", "regen", "--client", opts.client, "--run-id", id];
  if (opts.mock) args.push("--mock");
  if (opts.dryRun) args.push("--dry-run");
  if (opts.useSavedToken) args.push("--use-saved-token");
  if (opts.pageType && opts.pageType !== "blog") args.push("--page-type", opts.pageType);
  if (opts.clusterIds.length) args.push("--cluster-ids", opts.clusterIds.join(","));
  if (opts.imageIds.length) args.push("--image-ids", opts.imageIds.join(","));
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
  if (!resolveClient(client)) {
    sendHtml(res, 400, shell("Error", `<div class="banner err">unknown client</div>`));
    return;
  }
  const clusterIds = body.getAll("cluster_id");
  const imageIds = body.getAll("image_id");
  if (clusterIds.length === 0 && imageIds.length === 0) {
    sendHtml(res, 400, shell("Error", `<div class="banner err">No images selected.</div>`));
    return;
  }
  const ptRaw = body.get("page_type");
  const pageType: PageType = ptRaw === "service" || ptRaw === "category" ? ptRaw : "blog";
  const state = startRegen({
    client,
    clusterIds,
    imageIds,
    dryRun: body.get("dry_run") === "on",
    mock: body.get("mock") === "on",
    useSavedToken: body.get("use_saved_token") === "on",
    assetTypes: body.get("asset_types") || undefined,
    pageType,
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

interface CsvRowParsed {
  image_id: string;
  asset_type: string;
  cluster_id: string;
  page_topic: string;
  image_url_new: string;
  image_local_path: string;
  description_used: string;
  prompt_used: string;
  aspect_ratio: string;
  generated_at_utc: string;
  status: string;
  error: string;
  client_slug: string;
  project_id: string;
}

async function readRunCsv(csvPath: string): Promise<CsvRowParsed[]> {
  try {
    const raw = await fs.readFile(csvPath, "utf8");
    const rows = csvParse(raw, { columns: true, skip_empty_lines: true }) as CsvRowParsed[];
    return rows;
  } catch {
    return [];
  }
}

/**
 * Walk ./out/manifest-*.json looking for the run-id stamp the CLI wrote
 * during regen. If found, build a synthetic RunState the run-page handler
 * can render from. log + listeners are empty (the live process is gone);
 * csvPath / htmlPath / done / exitCode come from the manifest.
 */
async function tryReconstructRunFromDisk(id: string): Promise<RunState | null> {
  const dir = path.resolve(process.cwd(), "out");
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return null;
  }
  for (const n of names) {
    if (!n.startsWith("manifest-") || !n.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(dir, n), "utf8");
      const j = JSON.parse(raw);
      if (j?.run_id !== id) continue;
      // Match — synthesise.
      const state: RunState = {
        id,
        client: typeof j.client === "string" ? j.client : "",
        args: ["(persisted run)"],
        startedAt: typeof j.started_at === "string" ? j.started_at : "",
        log: ["(log not available — server was restarted after this run finished)\n"],
        done: true,
        exitCode: 0,
        csvPath: typeof j.csv === "string" ? j.csv : undefined,
        htmlPath: typeof j.html === "string" ? j.html : undefined,
        proc: { kill() { /* no-op */ } } as unknown as ChildProcess,
        listeners: new Set(),
      };
      RUNS.set(id, state);
      return state;
    } catch {
      /* skip corrupt manifest */
    }
  }
  return null;
}

async function runPage(res: ServerResponse, id: string) {
  let state = RUNS.get(id);
  if (!state) {
    // Manifest fallback: a previous server process spawned this run; the
    // in-memory state is gone but the artefacts are still on disk.
    // Reconstruct a "completed" RunState from the manifest so the publish
    // view still renders. The log + live SSE features won't work here —
    // the operator gets the persisted CSV + cluster grid only.
    const reconstructed = await tryReconstructRunFromDisk(id);
    if (!reconstructed) {
      sendHtml(res, 404, shell("Not found", `<div class="banner err">run ${esc(id)} not found</div>`));
      return;
    }
    state = reconstructed;
  }
  const initial = esc(state.log.join(""));
  const cmd = esc(`npx ${state.args.join(" ")}`);

  // If the run is done and a CSV exists, build the publish view —
  // workspace-mirrored: one cluster card per affected cluster, with
  // a click-anywhere row that opens a drawer of new-image cards
  // (per-image Apply + Regenerate). Bulk "Apply all pending" lives
  // in the sticky publish action bar at the bottom of the page.
  let resultsHtml = "";
  if (state.done && state.csvPath) {
    const rows = await readRunCsv(state.csvPath);
    if (rows.length > 0) {
      const grouped = new Map<string, { topic: string; rows: CsvRowParsed[] }>();
      for (const r of rows) {
        const g = grouped.get(r.cluster_id) ?? { topic: r.page_topic, rows: [] };
        g.rows.push(r);
        grouped.set(r.cluster_id, g);
      }
      const totalCompleted = rows.filter((r) => r.status === "completed").length;
      const totalFailed = rows.filter((r) => r.status === "failed").length;

      // Inline cluster sections. Each card has just two controls:
      // Apply (S3 PutObject) and Regenerate (re-runs that single
      // image through the pipeline).
      const clusterSections = [...grouped.entries()].map(([clusterId, g]) => {
        const cards = g.rows
          .map((r) => {
            const previewHtml = r.image_url_new
              ? `<img src="${esc(r.image_url_new)}" alt="" loading="lazy" onclick="lbOpen(event, this.src, ${jsAttr(r.asset_type + " · " + r.image_id)})">`
              : `<div class="ph">${esc(r.status)}</div>`;
            const errCell = r.error
              ? `<div class="err-line">${esc(r.error.slice(0, 240))}</div>`
              : "";
            const synthetic = r.image_id.includes("/");
            return `
<div class="result-card" data-image-id="${esc(r.image_id)}" data-cluster-id="${esc(clusterId)}" data-state="pending"${synthetic ? ' data-synthetic="1"' : ""}>
  <div class="rc-img">${previewHtml}</div>
  <div class="rc-body">
    <div class="rc-row">
      <span class="pill ${esc(r.asset_type)}">${esc(r.asset_type)} · ${esc(r.aspect_ratio)}</span>
      <span class="state-pill"></span>
    </div>
    <div class="rc-id"><code>${esc(r.image_id)}</code></div>
    <div class="rc-desc">${esc((r.description_used || "").slice(0, 220))}</div>
    ${errCell}
    <div class="rc-status-line"></div>
    <div class="rc-actions">
      <button class="btn-regen" onclick="regenOne('${esc(r.image_id)}')" title="Regenerate this image">↻ Regenerate</button>
      <button class="btn-apply primary" onclick="applyOne('${esc(r.image_id)}')" ${synthetic ? `disabled title="Apply not yet supported for synthetic cover/thumbnail IDs"` : `title="Push to s3://gw-content-store/website/.../assets/blog-images/<cluster>/<image_id>/{1080,720,360}.webp"`}>Apply to S3</button>
    </div>
  </div>
</div>`;
          })
          .join("");
        return `
<section class="card cluster-section" id="cluster-${esc(clusterId)}">
  <header class="cs-head">
    <div>
      <div style="font-weight:600;font-size:14px">${esc(g.topic || "(no topic)")}</div>
      <div class="sub"><code>${esc(clusterId)}</code> · ${g.rows.length} new images</div>
    </div>
    <div class="cs-actions">
      <button onclick="applyCluster('${esc(clusterId)}')">Apply all in this cluster</button>
    </div>
  </header>
  <div class="result-grid">${cards}</div>
</section>`;
      }).join("");

      resultsHtml = `
<section class="card" id="results-summary">
  <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
    <h2 style="margin:0">Publish — verify and push to S3</h2>
    <span class="sub">${rows.length} new images across ${grouped.size} clusters · <strong style="color:var(--ok)">${totalCompleted} ready</strong>${totalFailed ? ` · <strong style="color:var(--err)">${totalFailed} failed</strong>` : ""}</span>
  </div>
  <div class="sub" style="margin-top:6px">Click any image to enlarge. <strong>Regenerate</strong> swaps the image in-place (so you can keep clicking until you like the result). <strong>Apply to S3</strong> downloads the new image and PUTs it to <code>gw-content-store</code> at the canonical key the rendering pipeline reads from. Cover / thumbnail rows are disabled for now (synthetic IDs need cover/thumbnail wiring next iteration).</div>
</section>

${clusterSections}

<!-- Sticky bottom action bar -->
<div class="action-bar">
  <div class="stats">
    <strong id="applied-count">0</strong> applied · <strong id="failed-count">0</strong> failed · <strong id="pending-count">0</strong> pending
  </div>
  <div class="right">
    <button class="primary" id="apply-all-btn" onclick="applyAll()">Apply all pending →</button>
  </div>
</div>
`;
    }
  }

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
    <a class="btn" href="/workspace/${esc(state.client)}">← back to workspace</a>
  </div>
</section>

<details class="card" ${state.done ? "" : "open"}>
  <summary><h2 style="display:inline">Log</h2></summary>
  <div id="log" class="log" style="margin-top:10px">${initial}</div>
</details>

${resultsHtml}

<!-- Lightbox -->
<div class="lightbox-overlay" id="rp-lightbox" onclick="lbBackdrop(event)">
  <button class="close-x" onclick="lbClose()" aria-label="Close">×</button>
  <img id="rp-lb-img" src="" alt="">
  <div class="caption" id="rp-lb-cap"></div>
</div>
`, `<script>
const logEl = document.getElementById('log');
const statusEl = document.getElementById('status');
const linksEl = document.getElementById('links');
const RUN_ID = window.location.pathname.split('/').pop();

// Per-image state machine. Two user actions: Apply (push to S3) and
// Regenerate (re-roll the image). State is purely about Apply progress:
//   pending  → not yet applied
//   applying → in flight (network + S3 PUT)
//   applied  → terminal success
//   failed   → terminal failure (operator can Regenerate to try again)
const stateOf = new Map(); // image_id → 'pending' | 'applying' | 'applied' | 'failed'

function paintCard(imageId, opts) {
  const card = document.querySelector('.result-card[data-image-id="' + CSS.escape(imageId) + '"]');
  if (!card) return;
  const s = stateOf.get(imageId) ?? 'pending';
  card.dataset.state = s;
  const pill = card.querySelector('.state-pill');
  if (pill) {
    pill.textContent = s === 'pending' ? '' : s;
    pill.className = 'state-pill state-' + s;
  }
  const applyBtn = card.querySelector('.btn-apply');
  if (applyBtn) {
    if (s === 'applied') { applyBtn.textContent = 'Applied ✓'; applyBtn.disabled = true; }
    else if (s === 'applying') { applyBtn.textContent = 'Applying…'; applyBtn.disabled = true; }
    else if (s === 'failed') { applyBtn.textContent = 'Retry apply'; applyBtn.disabled = false; }
    else { applyBtn.textContent = 'Apply to S3'; applyBtn.disabled = card.dataset.synthetic === '1'; }
  }
  const errLine = card.querySelector('.rc-status-line');
  if (errLine) {
    errLine.textContent = (s === 'failed' && opts && opts.error) ? opts.error : '';
    errLine.style.display = (s === 'failed' && opts && opts.error) ? 'block' : 'none';
  }
}

async function applyOne(imageId) {
  const cur = stateOf.get(imageId) ?? 'pending';
  if (cur === 'applied' || cur === 'applying') return;
  const card = document.querySelector('.result-card[data-image-id="' + CSS.escape(imageId) + '"]');
  if (!card) return;
  if (card.dataset.synthetic === '1') {
    paintCard(imageId, { error: 'Apply not yet supported for cover/thumbnail synthetic IDs.' });
    stateOf.set(imageId, 'failed');
    paintCard(imageId, { error: 'Apply not yet supported for cover/thumbnail synthetic IDs.' });
    refreshTotals();
    return;
  }
  stateOf.set(imageId, 'applying'); paintCard(imageId);
  try {
    const r = await fetch('/api/apply-one', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ run_id: RUN_ID, image_id: imageId, cluster_id: card.dataset.clusterId })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    stateOf.set(imageId, 'applied'); paintCard(imageId);
  } catch (err) {
    stateOf.set(imageId, 'failed');
    paintCard(imageId, { error: 'apply failed: ' + err.message });
  }
  refreshTotals();
}

async function applyCluster(clusterId) {
  const cards = document.querySelectorAll('.result-card[data-cluster-id="' + CSS.escape(clusterId) + '"]');
  for (const card of cards) {
    const id = card.dataset.imageId;
    if (!id) continue;
    const s = stateOf.get(id) ?? 'pending';
    if (s === 'applied' || s === 'applying') continue;
    if (card.dataset.synthetic === '1') continue;
    await applyOne(id); // sequential to avoid hammering S3
  }
}

async function applyAll() {
  const allCards = document.querySelectorAll('.result-card[data-image-id]');
  for (const card of allCards) {
    const id = card.dataset.imageId;
    if (!id) continue;
    const s = stateOf.get(id) ?? 'pending';
    if (s === 'applied' || s === 'applying') continue;
    if (card.dataset.synthetic === '1') continue;
    await applyOne(id);
  }
}

async function regenOne(imageId) {
  const card = document.querySelector('.result-card[data-image-id="' + CSS.escape(imageId) + '"]');
  if (!card) return;
  const btn = card.querySelector('.btn-regen');
  if (btn) { btn.textContent = '…'; btn.disabled = true; }
  try {
    const r = await fetch('/api/regen-one', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image_id: imageId, cluster_id: card.dataset.clusterId })
    });
    if (!r.ok) throw new Error(await r.text());
    const j = await r.json();
    const img = card.querySelector('.rc-img img');
    if (img && j.image_url_new) img.src = j.image_url_new;
    // A regenerated image returns to pending so the operator decides
    // whether to Apply this one.
    stateOf.set(imageId, 'pending');
    paintCard(imageId);
  } catch (err) {
    stateOf.set(imageId, 'failed');
    paintCard(imageId, { error: 'regenerate failed: ' + err.message });
  } finally {
    if (btn) { btn.textContent = '↻ Regenerate'; btn.disabled = false; }
  }
  refreshTotals();
}

function refreshTotals() {
  const allCards = document.querySelectorAll('.result-card[data-image-id]');
  let pending = 0, applied = 0, failed = 0;
  for (const card of allCards) {
    const id = card.dataset.imageId;
    if (!id) continue;
    const s = stateOf.get(id) ?? 'pending';
    if (s === 'applied') applied++;
    else if (s === 'failed') failed++;
    else pending++;
  }
  const setText = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n; };
  setText('applied-count', applied);
  setText('failed-count', failed);
  setText('pending-count', pending);
  const btn = document.getElementById('apply-all-btn');
  if (btn) btn.disabled = pending === 0;
}

// Lightbox (full-screen image viewer)
function lbOpen(ev, src, caption) {
  if (ev) ev.stopPropagation();
  document.getElementById('rp-lb-img').src = src;
  document.getElementById('rp-lb-cap').textContent = caption || '';
  document.getElementById('rp-lightbox').classList.add('open');
}
function lbClose() {
  const lb = document.getElementById('rp-lightbox');
  if (lb) lb.classList.remove('open');
  const img = document.getElementById('rp-lb-img');
  if (img) img.src = '';
}
function lbBackdrop(ev) { if (ev.target === ev.currentTarget) lbClose(); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') lbClose(); });

if (document.getElementById('apply-all-btn')) refreshTotals();

${state.done ? "" : `
const es = new EventSource('/runs/${esc(id)}/events');
es.onmessage = (ev) => {
  try { const { text } = JSON.parse(ev.data); logEl.textContent += text; logEl.scrollTop = logEl.scrollHeight; } catch {}
};
es.addEventListener('end', (ev) => {
  const { code } = JSON.parse(ev.data);
  statusEl.innerHTML = code === 0 ? '<div class="banner ok">finished, exit 0 — reloading to render the publish view…</div>' : '<div class="banner err">exited with code ' + code + '</div>';
  // The publish view (per-card Apply + Regenerate) is rendered
  // server-side from the freshly-written CSV. Reload once the run
  // finishes so it appears inline without an extra click.
  if (code === 0) setTimeout(() => window.location.reload(), 800);
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

      // /import?client=<slug> — page-type chooser shown after the
      // operator picks a client on the home page.
      if (method === "GET" && p === "/import") {
        const slug = url.searchParams.get("client") ?? "";
        if (!slug) {
          res.writeHead(302, { location: "/" });
          res.end();
          return;
        }
        return await importPage(res, decodeURIComponent(slug));
      }

      const wsBrandMatch = /^\/workspace\/([^/]+)\/brand$/.exec(p);
      if (method === "POST" && wsBrandMatch && wsBrandMatch[1]) {
        return await saveBrandHandler(req, res, decodeURIComponent(wsBrandMatch[1]));
      }
      const wsLogoMatch = /^\/workspace\/([^/]+)\/logo$/.exec(p);
      if (method === "POST" && wsLogoMatch && wsLogoMatch[1]) {
        return await saveLogoHandler(req, res, decodeURIComponent(wsLogoMatch[1]));
      }
      const wsMatch = /^\/workspace\/([^/]+)\/?$/.exec(p);
      if (method === "GET" && wsMatch && wsMatch[1]) {
        const ptRaw = url.searchParams.get("page_type");
        const pageType: PageType = ptRaw === "service" || ptRaw === "category" ? ptRaw : "blog";
        const selectedRaw = url.searchParams.get("selected") ?? "";
        const selected = new Set<PageType>();
        for (const t of selectedRaw.split(",").map((s) => s.trim())) {
          if (t === "blog" || t === "service" || t === "category") selected.add(t);
        }
        return await workspacePage(
          res,
          decodeURIComponent(wsMatch[1]),
          pageType,
          selected.size > 0 ? selected : undefined,
        );
      }

      if (method === "POST" && p === "/regen") return await regenPostHandler(req, res);
      if (method === "POST" && p === "/api/regen-one") return await regenOneHandler(req, res);
      if (method === "POST" && p === "/api/apply-one") return await applyOneHandler(req, res);
      if (method === "GET" && p === "/api/projects/search") {
        try {
          loadEnv();
          const q = url.searchParams.get("q") ?? "";
          const limit = Math.min(20, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "20", 10) || 20));
          const hits = await searchProjects(q, limit);
          return sendJson(res, 200, { hits });
        } catch (err) {
          return sendJson(res, 500, { error: (err as Error).message });
        }
      }
      if (method === "GET" && p === "/api/page-type-counts") {
        try {
          loadEnv();
          const pid = url.searchParams.get("project_id") ?? "";
          if (!/^[0-9a-f-]{36}$/i.test(pid)) return sendJson(res, 400, { error: "project_id required" });
          const counts = await publishedClusterCountsByPageType(pid);
          return sendJson(res, 200, { counts });
        } catch (err) {
          return sendJson(res, 500, { error: (err as Error).message });
        }
      }
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
