import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import { runOutDir } from "./runOutDir.js";
import { randomUUID } from "node:crypto";
import { CLIENTS, findClient } from "./clients.js";
import {
  closePool,
  listPublishedClusters,
  lookupClusterSlugs,
  lookupImageUrls,
  publishedClusterCountsByPageType,
  lookupProjectById,
  searchProjects,
  type ClusterRow,
  type ProjectRow,
  type PageType,
} from "./db.js";
import { collectImageRecords, prefetchBlogMarkdowns, type ImageRecord } from "./pageInfo.js";
import { loadEnv } from "./env.js";
import {
  loadBrandGuidelines,
  saveBrandGuidelines,
  loadToken,
  loadProjectOverrides,
  saveProjectOverrides,
  tokenStoreLayout,
} from "./tokens.js";
import { promises as fs } from "node:fs";
import { parse as csvParse } from "csv-parse/sync";
import { uploadBlogImage } from "./s3.js";
import { uploadRows } from "./upload.js";
import { repointMappingRows, type MapRow } from "./repoint.js";
import { latestBackupForCluster, revertBackups, DEFAULT_BACKUPS_DIR } from "./revert.js";
// archiver is CommonJS. Node's ESM loader refuses `import archiver
// from "archiver"` because the CJS module has no static `default`
// export — so we go through `createRequire` to load it. The types
// still come from @types/archiver.
import { createRequire } from "node:module";
import type ArchiverDefault from "archiver";
const requireCjs = createRequire(import.meta.url);
const archiver: typeof ArchiverDefault = requireCjs("archiver");
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import {
  loadRetentionConfig,
  sweepRunRetention,
  expiryForRun,
  type RetentionConfig,
} from "./retention.js";

const LOGO_URL = "https://cdn.gushwork.ai/v2/gush_new_logo.svg";
const APP_TITLE = "Feeds Image Updater";

// Inline-SVG favicon — purple gradient circle with a refresh-arrow
// over a stylised image frame. Encoded as a data URI so we don't ship
// a separate file.
const FAVICON_DATA_URI = (() => {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>
  <defs><linearGradient id='g' x1='0' x2='1' y1='0' y2='1'>
    <stop offset='0' stop-color='%231e1b4b'/><stop offset='1' stop-color='%234338ca'/>
  </linearGradient></defs>
  <rect width='64' height='64' rx='14' fill='url(%23g)'/>
  <rect x='14' y='17' width='30' height='22' rx='3' fill='none' stroke='%23fff' stroke-width='3'/>
  <circle cx='22' cy='25' r='3' fill='%23fff'/>
  <path d='M14 35 l8-8 6 6 4-4 8 8' fill='none' stroke='%23fff' stroke-width='3' stroke-linejoin='round'/>
  <path d='M44 36 a8 8 0 1 1 -2 -7' fill='none' stroke='%23fff' stroke-width='3.2' stroke-linecap='round'/>
  <polygon points='42,28 50,28 46,21' fill='%23fff'/>
</svg>`.replace(/\s+/g, " ").trim();
  return `data:image/svg+xml;utf8,${svg}`;
})();

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
  /**
   * "regen" — generated via Replicate/fal subprocess (default).
   * "upload" — operator dropped client-provided replacement images.
   * The Apply pipeline is identical for both; only the source of
   * image_local_path differs (regen subprocess vs HTTP upload).
   */
  mode?: "regen" | "upload";
}

const RUNS = new Map<string, RunState>();

// Server-process S3 markdown cache with a 60-second TTL. Without this
// every workspace render re-fetches every blog cluster's
// blog_with_image_placeholders.md, which dominates wall time. Repeated
// loads of the same workspace within the TTL are sub-second.
const S3_CACHE_TTL_MS = 60 * 1000;
const GLOBAL_S3_CACHE = new Map<string, { body: string | null; expires: number }>();
function cacheGet(key: string): string | null | undefined {
  const e = GLOBAL_S3_CACHE.get(key);
  if (!e) return undefined;
  if (Date.now() > e.expires) { GLOBAL_S3_CACHE.delete(key); return undefined; }
  return e.body;
}
function cacheSet(key: string, body: string | null): void {
  GLOBAL_S3_CACHE.set(key, { body, expires: Date.now() + S3_CACHE_TTL_MS });
}

/**
 * Pre-fill a per-request cache from the long-lived process cache and
 * (after the prefetch runs) sync the freshly-fetched entries back
 * into the global. Keys are prefixed with the staging_subdomain so
 * the same cluster_id under different clients doesn't collide.
 */
function buildS3Cache(stagingSubdomain: string | null): Map<string, string | null> {
  const m = new Map<string, string | null>();
  if (!stagingSubdomain) return m;
  for (const [k, v] of GLOBAL_S3_CACHE) {
    if (Date.now() > v.expires) continue;
    if (!k.startsWith(stagingSubdomain + ":")) continue;
    m.set(k.slice(stagingSubdomain.length + 1), v.body);
  }
  return m;
}
function syncToGlobalCache(local: Map<string, string | null>, stagingSubdomain: string | null) {
  if (!stagingSubdomain) return;
  for (const [k, v] of local) {
    cacheSet(`${stagingSubdomain}:${k}`, v);
  }
}
void cacheGet;

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
  // Browser tab title is always "Feeds Image Updater" (the per-page
  // crumb appears in the in-app header instead).
  void title;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(APP_TITLE)}</title>
<link rel="icon" type="image/svg+xml" href="${FAVICON_DATA_URI}">
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

  /* Home hero — gradient frame + larger search prompt + tightened
     typography. Quietly elevated; not a marketing page. */
  .hero {
    background: linear-gradient(135deg, #1e1b4b 0%, #312e81 38%, #4338ca 100%);
    border-radius: 14px;
    padding: 36px 32px 28px;
    color: #fff;
    box-shadow: 0 12px 32px rgba(48,46,134,.18);
    margin-bottom: 14px;
  }
  .hero-inner { max-width: 760px; margin: 0 auto; }
  .hero-h { margin: 0 0 6px; font-size: 26px; font-weight: 600; letter-spacing: -.015em; }
  .hero-sub { margin: 0 0 22px; font-size: 13.5px; line-height: 1.55; color: rgba(255,255,255,.78); max-width: 620px; }
  .hero-search { display: flex; gap: 10px; align-items: stretch; flex-wrap: wrap; }
  .hero-search .combobox { flex: 1; min-width: 280px; }
  .hero-search .combo-field { padding: 6px; border-radius: 8px; }
  .hero-search .combo-field:focus-within { outline: 2px solid rgba(255,255,255,.5); }
  .hero-btn { padding: 12px 22px; border-radius: 8px; font-size: 14px; font-weight: 600; }
  /* Hero CTA: white fill + indigo text — readable contrast against the dark gradient. */
  button.primary.hero-btn, .btn.primary.hero-btn { background: #fff; color: var(--brand); border-color: #fff; box-shadow: 0 4px 12px rgba(0,0,0,.18); }
  button.primary.hero-btn:hover, .btn.primary.hero-btn:hover { background: #f5f3ff; color: var(--brand-hover); border-color: #f5f3ff; }
  button.primary.hero-btn:disabled { background: rgba(255,255,255,.55); color: rgba(67,56,202,.55); border-color: transparent; box-shadow: none; }
  .hero-hint { margin: 14px 0 0; font-size: 12px; color: rgba(255,255,255,.62); }
  .hero-hint code { background: rgba(255,255,255,.12); color: #fff; }

  /* How-it-works — single horizontal strip with a title + one-liner
     under each step. Cards adjust their height to fit text; on narrow
     viewports the strip wraps onto multiple rows so nothing overflows. */
  .howto { padding: 14px 18px; }
  .howto-head { margin-bottom: 10px; }
  .howto-head h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .07em; color: var(--ink-muted); margin: 0; }
  .howto-steps {
    list-style: none; padding: 0; margin: 0;
    display: flex; align-items: stretch; gap: 6px; flex-wrap: wrap;
  }
  .howto-steps li {
    display: flex; align-items: flex-start; gap: 10px;
    padding: 10px 12px; background: #f8fafc;
    border: 1px solid var(--border); border-radius: 10px;
    flex: 1 1 180px; min-width: 0;
  }
  .howto-steps li > div { min-width: 0; flex: 1; }
  .howto-num {
    flex: 0 0 22px; width: 22px; height: 22px;
    display: inline-flex; align-items: center; justify-content: center;
    background: linear-gradient(135deg, var(--brand) 0%, #6366f1 100%);
    color: #fff; border-radius: 50%; font-weight: 600; font-size: 11px;
    margin-top: 1px;
  }
  .howto-label { font-size: 12.5px; font-weight: 600; color: var(--ink); line-height: 1.3; word-wrap: break-word; }
  .howto-sub { font-size: 11.5px; color: var(--ink-muted); line-height: 1.4; margin-top: 2px; word-wrap: break-word; }
  /* Arrow between consecutive chips — vertically centered on the card. */
  .howto-steps li + li::before {
    content: "→"; color: var(--ink-faint); font-weight: 600;
    align-self: center; margin: 0 -2px 0 -2px; flex: 0 0 auto;
  }

  .recent-head { display: flex; align-items: center; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--border); }
  .recent-row td { padding: 11px 14px; font-size: 13px; }
  .recent-row a.recent-link { color: inherit; text-decoration: none; display: flex; align-items: center; gap: 8px; }
  .recent-row a.recent-link:hover { text-decoration: none; }
  .ts-ist { font-size: 12px; color: var(--ink-muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .fav { width: 16px; height: 16px; border-radius: 3px; object-fit: contain; flex: 0 0 16px; background: #f1f5f9; }
  .combobox .opt-name { display: flex; align-items: center; gap: 8px; }
  .combobox .opt-name strong { font-weight: 500; }
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
  table.cluster-list td.preview img,
  table.cluster-list td.preview .placeholder { object-fit: cover; border-radius: 4px; border: 1px solid var(--border); display: block; background: #f1f5f9; }
  table.cluster-list td.preview .placeholder { border-style: dashed; background: #f8fafc; border-color: var(--border-strong); }
  /* Aspect-ratio variants — width fixed, height computed. */
  table.cluster-list td.preview .ar-16x9 { width: 64px; height: 36px; }
  table.cluster-list td.preview .ar-1x1  { width: 48px; height: 48px; }
  table.cluster-list td.types .pills-wrap { display: flex; flex-wrap: wrap; gap: 3px; }

  /* Recent-runs table — dedicated tweaks on top of the .cluster-list
     base styles. Tabular nums for the numeric columns; a slightly
     denser row; subtle right-alignment for the counters. */
  table.recent-runs { width: 100%; }
  table.recent-runs th, table.recent-runs td { padding: 9px 12px; font-size: 13px; vertical-align: middle; }
  /* The .cluster-list base sets th { position: sticky; top: 49px } —
     that's right for the cluster picker on the workspace page (which
     has a 49px sub-nav above) but on the home page there's no nav,
     so the sticky offset leaves a 49px phantom gap above the header
     row. Reset to static for the recent-runs context. */
  table.recent-runs th { position: static; top: auto; background: #f8fafc; }
  table.recent-runs th.num, table.recent-runs td.num { text-align: right; font-variant-numeric: tabular-nums; }
  table.recent-runs th.num { padding-right: 14px; }
  table.recent-runs td.client { white-space: nowrap; }
  table.recent-runs td.client .fav { width: 16px; height: 16px; vertical-align: middle; margin-right: 6px; border-radius: 3px; }
  table.recent-runs td.pt { font-size: 11px; color: var(--ink-muted); white-space: nowrap; }
  table.recent-runs td.started { font-size: 12px; color: var(--ink-muted); white-space: nowrap; }
  table.recent-runs td.applied-cell { font-variant-numeric: tabular-nums; text-align: right; }
  table.recent-runs td.applied-cell .has { color: #047857; font-weight: 600; }
  table.recent-runs td.applied-cell .has .check { margin-left: 4px; color: #16a34a; font-weight: 700; }
  /* Type chip in the Type column — visually separates Generate vs
     Upload runs at a glance. Sizes match the existing .pill style. */
  .run-type-chip {
    display: inline-block; padding: 2px 8px; border-radius: 999px;
    font-size: 11px; font-weight: 500; white-space: nowrap;
  }
  .run-type-chip.run-type-regen  { background: #e0e7ff; color: #3730a3; }
  .run-type-chip.run-type-upload { background: #fef3c7; color: #92400e; }
  table.recent-runs td.run-type-cell { white-space: nowrap; }
  /* "Run by" — shows email local-part, full email on hover. Falls
     back to a muted dash for legacy runs (created before this
     instrumentation, or before the operator had pasted a token). */
  table.recent-runs td.run-by-cell { white-space: nowrap; font-size: 12px; }
  table.recent-runs .run-by         { color: var(--ink); }
  table.recent-runs .run-by-empty   { color: var(--ink-faint); }
  table.recent-runs td.applied-cell .none { color: var(--ink-faint); }
  table.recent-runs tr.recent-row { cursor: pointer; }
  table.recent-runs tr.recent-row:hover td { background: #f8fafc; }
  table.recent-runs a.recent-link { color: inherit; text-decoration: none; display: block; }
  table.recent-runs tr.row-hidden { display: none; }
  /* Green left-edge stripe + soft tint for fully-applied runs so a
     glance at the table shows which clients are fully published.
     Partial-apply runs get a milder amber stripe; runs with zero
     applies stay neutral. */
  table.recent-runs tr.apply-full td:first-child {
    box-shadow: inset 3px 0 0 #16a34a;
  }
  table.recent-runs tr.apply-full td { background: #f0fdf4; }
  table.recent-runs tr.apply-full:hover td { background: #dcfce7; }
  table.recent-runs tr.apply-partial td:first-child {
    box-shadow: inset 3px 0 0 #f59e0b;
  }

  /* Tab bar above the recent-runs table — newest 50 / next 50 / etc.
     Active tab gets a brand-coloured underline; inactive tabs are
     muted text on a transparent background, hover lifts them. The
     bar lives between the toolbar and the table. */
  .recent-tabs {
    display: flex; gap: 4px; padding: 0 16px;
    border-bottom: 1px solid var(--border); background: #fbfbfd;
  }
  .recent-tabs button {
    background: transparent; border: 0; padding: 10px 14px;
    font-size: 13px; color: var(--ink-muted); cursor: pointer;
    border-bottom: 2px solid transparent;
    font-variant-numeric: tabular-nums;
  }
  .recent-tabs button:hover { color: var(--ink); }
  .recent-tabs button.active {
    color: var(--ink); font-weight: 600;
    border-bottom-color: var(--brand, #2563eb);
  }

  /* Single-line toolbar: title + count + search + filter dropdowns
     all on one row. Search bar takes the spare horizontal space
     (flex:1) so it never forces the dropdowns to wrap. */
  .recent-toolbar {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 16px; border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .recent-toolbar h2 { margin: 0; font-size: 16px; flex-shrink: 0; }
  .recent-toolbar .count-chip {
    background: #eef2f7; color: var(--ink-muted);
    padding: 2px 8px; border-radius: 999px; font-size: 12px;
    font-variant-numeric: tabular-nums; flex-shrink: 0;
  }
  .recent-toolbar input[type="search"] {
    flex: 1 1 220px; min-width: 0;
  }
  .recent-toolbar input[type="search"],
  .recent-toolbar select {
    font-size: 13px; padding: 6px 10px; border: 1px solid var(--border);
    border-radius: 6px; background: #fff; color: var(--ink);
    height: 34px; box-sizing: border-box;
  }
  .recent-toolbar select { cursor: pointer; flex-shrink: 0; }

  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 500; }
  .pill.cover { background: #dbeafe; color: #1e40af; }
  .pill.thumbnail { background: #ede9fe; color: #5b21b6; }
  .pill.infographic { background: #fef3c7; color: #92400e; }
  .pill.internal { background: #d1fae5; color: #065f46; }
  .pill.external { background: #fce7f3; color: #9d174d; }
  .pill.generic { background: #e5e7eb; color: #374151; }
  /* Service / category asset pills — same visual language as cover/thumbnail. */
  .pill.service_h1 { background: #cffafe; color: #155e75; }
  .pill.service_body { background: #e0f2fe; color: #075985; }
  .pill.category_industry { background: #ffedd5; color: #9a3412; }

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
  .img-card .pre { width: 96px; border-radius: 6px; border: 1px solid var(--border); background: #f1f5f9; overflow: hidden; display: flex; align-items: center; justify-content: center; }
  .img-card.pre-16x9 .pre { height: 54px; }
  .img-card.pre-1x1 .pre { height: 96px; }
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

  /* "View current page" CTA on each cluster row — single-line, compact. */
  .btn-published { white-space: nowrap; padding: 5px 10px; font-size: 12px; line-height: 1.2; }

  /* Workspace client logo — bigger preview, hover-grow, click-to-expand. */
  .logo-preview-wrap { position: relative; width: 120px; flex: 0 0 120px; }
  .logo-preview {
    width: 120px; height: 120px; border-radius: 12px;
    object-fit: contain; background: #fff;
    border: 1px solid var(--border); padding: 10px;
    display: block; cursor: zoom-in;
    transition: transform .18s ease, box-shadow .18s ease, border-color .18s;
    box-shadow: var(--shadow);
  }
  .logo-preview:hover { transform: scale(1.06); box-shadow: var(--shadow-lg); border-color: var(--brand); }
  .logo-preview.no-logo {
    display: flex; align-items: center; justify-content: center;
    color: var(--ink-faint); font-size: 12px; cursor: default;
    background: #f8fafc; border-style: dashed;
  }
  .logo-preview.no-logo:hover { transform: none; box-shadow: var(--shadow); border-color: var(--border-strong); }

  /* Client info card — nested details for graphic_token / company_info / etc. */
  .info-grid { display: grid; grid-template-columns: 200px 1fr; gap: 8px 16px; align-items: start; font-size: 13px; }
  .info-grid .k { color: var(--ink-muted); font-size: 12px; }
  .info-grid .v { word-break: break-word; }
  .json-dump { background: #f8fafc; border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; font: 11.5px/1.45 ui-monospace, Menlo, monospace; white-space: pre-wrap; max-height: 320px; overflow: auto; color: #334155; }
  .json-edit { font: 12px/1.55 ui-monospace, "JetBrains Mono", Menlo, monospace; background: #f8fafc; color: #334155; min-height: 280px; }
  /* Per-group prompt editor blocks inside the "Are you sure you want
     to generate?" modal. One <details> per group; the textarea uses
     the same .json-edit styling so multi-line prompts read well. */
  .gen-group { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 10px; background: #fff; }
  .gen-group > summary { padding: 10px 14px; cursor: pointer; user-select: none; display: flex; align-items: center; gap: 4px; }
  .gen-group[open] > summary { border-bottom: 1px solid var(--border); }
  .gen-group textarea.gen-system { width: 100%; min-height: 320px; box-sizing: border-box; }

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

  /* Flows page */
  .flow-card { padding-top: 14px; }
  .flow-head { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px solid var(--border); }
  .flow-meta { font-size: 12.5px; }
  .flow-prompt {
    background: #0f172a; color: #e2e8f0; padding: 12px 14px; border-radius: 8px;
    font: 11.5px/1.55 ui-monospace, "JetBrains Mono", Menlo, monospace;
    white-space: pre-wrap; max-height: 420px; overflow: auto; margin-top: 8px;
  }

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

  .pt-loading {
    display: flex; align-items: center; gap: 10px;
    padding: 18px 4px; color: var(--ink-muted); font-size: 13px;
  }

  /* /import page-type chooser (legacy fallback page) */
  .pt-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
  .pt-row { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border: 1px solid var(--border-strong); border-radius: 10px; cursor: pointer; transition: border-color .15s, background .15s; background: #fff; }
  .pt-row:has(input:checked) { border-color: var(--brand); background: var(--accent-bg); }
  .pt-row.disabled { opacity: .5; cursor: not-allowed; }
  .pt-row input { width: 18px; height: 18px; }
  .pt-meta .pt-label { font-weight: 500; font-size: 14px; color: var(--ink); }
  .pt-meta .pt-count { font-size: 12px; color: var(--ink-muted); margin-top: 2px; }

  /* Page-type tabs (blog / service / category) */
  /* Page-type pills (blog / service / category). Tri-state:
       active     — currently shown in the table (filled, dark)
       selected   — included in the workspace but not the active view
       unselected — not in the workspace at all (muted/dashed)
     Single click toggles the click target through the rules in tabBtn. */
  .page-tab { display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 999px; border: 1px solid var(--border); font-size: 12px; color: var(--ink-muted); background: #fff; text-decoration: none; cursor: pointer; transition: background .12s, color .12s, border-color .12s; }
  .page-tab:hover { color: var(--ink); border-color: var(--border-strong); text-decoration: none; }
  .page-tab.active { background: var(--ink); color: #fff; border-color: var(--ink); }
  .page-tab.active:hover { background: #1e293b; color: #fff; }
  .page-tab.selected { background: var(--accent-bg); color: var(--brand); border-color: #c7d2fe; }
  .page-tab.selected:hover { background: #e0e7ff; color: var(--brand); border-color: var(--brand); }
  .page-tab.unselected { background: #fff; color: var(--ink-faint); border-style: dashed; }
  .page-tab.unselected:hover { color: var(--ink); border-style: solid; }
  .page-tab .ct { font-size: 11px; opacity: .7; }
  .page-tab.active .ct { color: #cbd5e1; opacity: 1; }

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
  /* Unmistakable failure placeholder — replaces the bare status
     string when an image didn't generate. Operators were missing the
     subtle red err-line below the card; this one is impossible to
     miss inside the preview frame itself. */
  .result-card .rc-img .ph-failed {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 4px; color: var(--err); background: var(--err-bg);
    width: 100%; height: 100%; padding: 16px; text-align: center;
  }
  .ph-failed-icon { font-size: 28px; line-height: 1; }
  .ph-failed-hint { font-size: 11px; color: var(--err); opacity: .8; margin-top: 2px; }
  .result-card .rc-body { padding: 10px 12px 12px; }
  .result-card .rc-row { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
  .result-card .rc-id code { font-size: 10.5px; word-break: break-all; }
  .result-card .rc-desc { font-size: 12px; color: var(--ink-muted); margin-top: 6px; line-height: 1.45; }
  .result-card .err-line { background: var(--err-bg); color: var(--err); border-radius: 4px; padding: 4px 8px; margin-top: 6px; font-size: 11px; word-break: break-word; }
  .result-card .rc-actions { margin-top: 10px; display: flex; gap: 6px; }

  /* Drop-zone (upload-mode runs). Sits in the same slot as the
     regen image, same aspect ratio. Visual states:
       idle      — dashed border, faint background, instructions
       hover     — solid border + brand tint (operator is dragging
                   a file over this card)
       uploading — spinner + progress
       error     — red border + message
     When a file has been uploaded the dropzone is replaced by the
     /preview/ image; the card sprouts Replace + Clear buttons. */
  .result-card .rc-dropzone {
    width: 100%; height: 100%; display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    border: 2px dashed var(--border-strong);
    border-radius: 6px; background: #fafbfc; color: var(--ink-muted);
    text-align: center; padding: 12px; cursor: pointer;
    transition: background-color .15s ease, border-color .15s ease;
  }
  .result-card .rc-dropzone:hover { background: #f1f5f9; border-color: var(--brand); color: var(--ink); }
  .result-card .rc-dropzone.dragover { background: #eef2ff; border-color: var(--brand); border-style: solid; color: var(--brand); }
  .result-card .rc-dropzone .dz-icon { font-size: 24px; line-height: 1; margin-bottom: 4px; }
  .result-card .rc-dropzone .dz-text { font-size: 13px; font-weight: 600; }
  .result-card .rc-dropzone .dz-sub  { font-size: 10.5px; color: var(--ink-faint); margin-top: 2px; }
  .result-card .rc-dropzone.uploading,
  .result-card .rc-dropzone.error { cursor: default; }
  .result-card .rc-dropzone.uploading { background: #eff6ff; border-color: var(--brand); border-style: solid; color: var(--brand); }
  .result-card .rc-dropzone.error    { background: #fef2f2; border-color: #fca5a5; color: #991b1b; border-style: solid; }
  .result-card .rc-dropzone .dz-progress { font-variant-numeric: tabular-nums; font-size: 12px; margin-top: 6px; }
  .result-card .rc-dropzone .dz-err-msg  { font-size: 11.5px; margin-top: 4px; max-width: 220px; word-break: break-word; }

  /* Upload-mode card: hide the rc-img zoom button overlay when in
     the drop-zone state (no image to zoom into). */
  .result-card.upload-mode[data-needs-file="1"] .rc-img { cursor: default; }
  .result-card.upload-mode[data-needs-file="1"] .rc-img::after { display: none !important; }
  .result-card .btn-replace, .result-card .btn-clear {
    font-size: 12px; padding: 5px 10px;
  }
  .result-card .btn-clear:hover { color: #b91c1c; border-color: #fca5a5; }
  /* Aspect-mismatch banner inside an upload card, shown when the
     server flagged the dropped file's aspect against the slot. */
  .result-card .upload-warn {
    margin-top: 6px; padding: 6px 8px; border-radius: 4px;
    background: #fef3c7; color: #92400e; font-size: 11.5px;
  }
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

  /* Custom hover tooltip for disabled Apply buttons. The native
     title attribute is suppressed by some browsers on disabled
     buttons, so we wrap the button in a tooltip span. */
  .apply-tip { position: relative; display: inline-block; }
  .apply-tip[data-tip]:hover::after {
    content: attr(data-tip);
    position: absolute; bottom: calc(100% + 6px); left: 50%;
    transform: translateX(-50%);
    background: #111; color: #fff; padding: 5px 9px; border-radius: 4px;
    font-size: 11px; line-height: 1.35; white-space: normal; width: max-content; max-width: 280px;
    z-index: 1000; pointer-events: none;
    box-shadow: 0 4px 10px rgba(0,0,0,0.18);
  }
  .apply-tip[data-tip]:hover::before {
    content: ""; position: absolute; bottom: calc(100% + 1px); left: 50%;
    transform: translateX(-50%);
    border: 5px solid transparent; border-top-color: #111;
    z-index: 1000; pointer-events: none;
  }
  /* While a run-level apply is in flight, dim every apply control. */
  body[data-apply-busy="1"] .btn-apply,
  body[data-apply-busy="1"] #apply-all-btn,
  body[data-apply-busy="1"] button[onclick^="applyCluster"] { opacity: .55; pointer-events: none; }
  .result-card .state-pill { font-size: 10.5px; padding: 1px 8px; border-radius: 999px; font-weight: 500; }
  .result-card .state-pill.state-applying { background: var(--accent-bg); color: var(--brand); }
  .result-card .state-pill.state-applied  { background: var(--ok); color: #fff; }
  .result-card .state-pill.state-failed   { background: var(--err-bg); color: var(--err); }
  .result-card .state-pill.state-pending  { display: none; }
  /* Per-image / per-cluster / all-image picks on the Publish (runs) page. */
  .rc-pick { position: absolute; top: 8px; left: 8px; z-index: 3;
    background: rgba(255,255,255,.85); backdrop-filter: blur(4px);
    border-radius: 6px; padding: 3px 4px 1px; box-shadow: var(--shadow);
    cursor: pointer; line-height: 1; }
  .rc-pick-cb { width: 16px; height: 16px; cursor: pointer; }
  .result-card { position: relative; }
  .cluster-section .cs-head { gap: 10px; }
  .cs-pick { display: inline-flex; align-items: center; cursor: pointer; flex: 0 0 auto; }
  .cs-pick-cb { width: 16px; height: 16px; cursor: pointer; }
  .all-pick { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ink-muted); padding: 4px 8px; border: 1px solid var(--border); border-radius: 6px; background: #fff; cursor: pointer; }
  .all-pick input { width: 16px; height: 16px; cursor: pointer; margin: 0; }
  /* Themed loader spinner — used by Regenerate (and any other long button). */
  @keyframes spinkey { to { transform: rotate(360deg); } }
  .spinner {
    display: inline-block; width: 12px; height: 12px;
    border: 2px solid currentColor; border-right-color: transparent;
    border-radius: 50%; vertical-align: -2px;
    animation: spinkey .7s linear infinite;
  }
  /* Regenerating shimmer over the existing image — matches the brand
     accent so it reads as "in flight". */
  @keyframes shimmerkey { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }
  .result-card.regenerating .rc-img { position: relative; overflow: hidden; }
  .result-card.regenerating .rc-img::before {
    content: ""; position: absolute; inset: 0;
    background: linear-gradient(110deg, transparent 0%, rgba(99,102,241,.18) 45%, rgba(99,102,241,.32) 50%, rgba(99,102,241,.18) 55%, transparent 100%);
    animation: shimmerkey 1.4s ease-in-out infinite;
    z-index: 2; pointer-events: none;
  }
  .result-card.regenerating .rc-img img { filter: brightness(.85) saturate(.7); }
  .result-card.regenerating .btn-regen { background: var(--accent-bg); color: var(--brand); border-color: #c7d2fe; }

  /* Per-card zoom + compare buttons. Zoom hovers in the top-right of
     the image; compare lives in the action row next to Apply. */
  .result-card .rc-img { position: relative; }
  .rc-zoom {
    position: absolute; top: 6px; right: 6px; z-index: 4;
    background: rgba(15,23,42,.75); color: #fff; border: 0;
    width: 28px; height: 28px; border-radius: 6px;
    font-size: 15px; line-height: 1; cursor: pointer;
    opacity: .7; transition: opacity .15s, background .15s;
  }
  .result-card:hover .rc-zoom { opacity: 1; }
  .rc-zoom:hover { background: var(--brand); opacity: 1; }
  /* Image inside the result card is also clickable (delegated). */
  .rc-img .rc-preview-img { cursor: zoom-in; }
  .btn-compare { font-size: 12px; padding: 5px 10px; }
  .btn-compare:hover { color: var(--brand); border-color: var(--brand); }
  /* "Regenerate with custom instructions" — a hyperlink-style trigger
     so it sits beside the main Regenerate button without competing
     for visual weight. */
  .btn-regen-custom {
    display: inline-flex; align-items: center; gap: 2px;
    background: transparent; border: 0; padding: 4px 6px;
    font-size: 12px; color: var(--ink-muted); cursor: pointer;
    text-decoration: underline; text-decoration-style: dotted;
    text-underline-offset: 2px;
  }
  .btn-regen-custom:hover { color: var(--brand); text-decoration-style: solid; }
  /* Per-card Download anchor — render like a button. */
  .btn-download { font-size: 12px; padding: 5px 10px; text-decoration: none; }
  .btn-download:hover { color: var(--brand); border-color: var(--brand); text-decoration: none; }
  /* Download retention notice on the run page. */
  .retention-badge {
    display: inline-flex; align-items: center; gap: 6px;
    background: var(--accent-bg); color: var(--brand);
    padding: 5px 10px; border-radius: 6px; font-size: 12px;
    border: 1px solid #c7d2fe;
  }
  .retention-badge .ret-left { color: var(--ink-muted); font-weight: 500; }

  /* Old-vs-new compare modal — two stacked or side-by-side panes. */
  .cmp-overlay {
    position: fixed; inset: 0; background: rgba(15,23,42,.78);
    backdrop-filter: blur(4px); z-index: 90;
    display: none; align-items: center; justify-content: center;
    padding: 24px;
  }
  .cmp-overlay.open { display: flex; }
  .cmp-modal {
    background: #fff; border-radius: 14px; box-shadow: var(--shadow-lg);
    max-width: 1280px; width: 100%; max-height: 92vh;
    display: flex; flex-direction: column; overflow: hidden;
  }
  .cmp-head { display: flex; align-items: center; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--border); }
  .cmp-head strong { font-size: 14px; word-break: break-all; }
  .cmp-head .sub { flex: 1; }
  .cmp-x { background: transparent; border: 0; font-size: 22px; line-height: 1; cursor: pointer; color: var(--ink-muted); padding: 4px 10px; border-radius: 6px; }
  .cmp-x:hover { background: #f1f5f9; color: var(--err); }
  .cmp-body { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--border); flex: 1; overflow: hidden; }
  .cmp-pane { background: #f8fafc; display: flex; flex-direction: column; min-height: 0; }
  .cmp-pane-h { padding: 10px 14px; font-size: 12px; font-weight: 600; color: var(--ink-muted); text-transform: uppercase; letter-spacing: .05em; background: #fff; border-bottom: 1px solid var(--border); }
  .cmp-pane-h.cmp-pane-h-new { color: var(--brand); }
  .cmp-pane img { flex: 1; min-height: 0; width: 100%; object-fit: contain; padding: 12px; }
  .cmp-ph { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; color: var(--ink-muted); padding: 24px; text-align: center; }
  @media (max-width: 768px) { .cmp-body { grid-template-columns: 1fr; } }

  /* Cluster section header on run page */
  .cluster-section .cs-head { display: flex; align-items: center; gap: 14px; margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px solid var(--border); }
  .cluster-section .cs-actions { margin-left: auto; display: flex; gap: 6px; }

  /* Combobox */
  .combobox { position: relative; }
  .combobox .combo-field input { padding-right: 36px; }
  .combobox .arrow { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); color: var(--ink-faint); pointer-events: none; }
  .combobox .menu {
    position: absolute; top: calc(100% + 4px); left: 0; right: 0;
    background: #fff; border: 1px solid var(--border-strong); border-radius: 6px;
    box-shadow: var(--shadow);
    max-height: 260px; overflow-y: auto; z-index: 5;
    display: none;
  }
  .combobox.open .menu { display: block; }
  /* Combobox input wrapper — the input control itself never disappears.
     When a client is picked, an inline chip appears INSIDE this
     wrapper, alongside the (now disabled) input. The × on the chip
     is the only way to clear. */
  .combo-field {
    display: flex; align-items: center; gap: 8px;
    border: 1px solid var(--border-strong); border-radius: 8px;
    background: #fff; padding: 4px;
    box-shadow: 0 4px 12px rgba(0,0,0,.06);
  }
  .combo-field:focus-within { outline: 2px solid var(--accent-bg); border-color: var(--brand); }
  .combo-field input {
    flex: 1; min-width: 80px;
    border: 0; outline: 0; padding: 8px 4px;
    background: transparent; box-shadow: none; font-size: 15px;
  }
  .hero-search .combo-field input { font-size: 15px; padding: 8px 6px; }
  .hero-search .combo-field input:disabled { cursor: default; background: transparent; }
  /* Error banner under the field when the user attempts a 2nd pick. */
  .combo-error {
    color: var(--err); background: var(--err-bg);
    border: 1px solid #fca5a5; border-radius: 6px;
    padding: 6px 10px; font-size: 13px; margin: 8px 0 0;
  }
  .combo-error[hidden] { display: none; }

  /* Inline picked chip. Lives in-flow inside .combo-field. */
  .combo-chip {
    display: inline-flex; align-items: center; gap: 8px; flex: 0 0 auto;
    background: var(--accent-bg); border: 1px solid #c7d2fe;
    border-radius: 6px; padding: 4px 4px 4px 10px;
    font-size: 13.5px; color: var(--brand); font-weight: 500;
  }
  .combo-chip[hidden] { display: none; }
  .combo-chip .fav { width: 16px; height: 16px; flex: 0 0 16px; border-radius: 3px; background: #fff; }
  .combo-chip span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px; }
  .combo-chip-x {
    margin-left: 2px; padding: 0 8px; font-size: 16px; line-height: 1;
    background: transparent; border: 0; color: var(--brand);
    cursor: pointer; border-radius: 4px; opacity: .7;
  }
  .combo-chip-x:hover { opacity: 1; color: var(--err); background: #fff; }
  .hero-search .combo-chip { font-size: 14px; padding: 6px 4px 6px 12px; }
  .hero-search .combo-chip .fav { width: 18px; height: 18px; flex: 0 0 18px; }
  /* Shake animation when a 2nd pick is attempted. */
  @keyframes shake-key { 10%,90% { transform: translateX(-1px); } 20%,80% { transform: translateX(2px); } 30%,50%,70% { transform: translateX(-3px); } 40%,60% { transform: translateX(3px); } }
  .combo-chip-shake { animation: shake-key .35s ease-in-out; border-color: var(--err); }
  .combobox .menu .opt { padding: 8px 12px; cursor: pointer; font-size: 13px; color: var(--ink); background: #fff; }
  .combobox .menu .opt:hover, .combobox .menu .opt.active { background: var(--accent-bg); color: var(--brand); }
  .combobox .menu .opt strong { color: inherit; }
  .combobox .menu .opt .pid { font-size: 11px; color: var(--ink-faint); margin-top: 2px; }

  .log { background: #0f172a; color: #e2e8f0; padding: 14px 16px; border-radius: 8px; font: 12px/1.55 ui-monospace, "JetBrains Mono", Menlo, monospace; white-space: pre-wrap; max-height: 60vh; overflow: auto; }

  /* Running hero — shown only while a run is in flight. Big spinner +
     auto-rotating tips + elapsed timer. Replaces the old "streaming…"
     banner with something the operator can actually look at. */
  .running-hero {
    display: flex; align-items: center; gap: 18px;
    padding: 22px 24px;
    background: linear-gradient(135deg, #1e1b4b 0%, #4338ca 100%);
    color: #fff; border: none;
  }
  .running-spinner-wrap { flex: 0 0 auto; }
  .running-spinner {
    display: inline-block; width: 32px; height: 32px;
    border: 3px solid rgba(255,255,255,.4); border-top-color: #fff;
    border-radius: 50%;
    animation: spinkey .9s linear infinite;
  }
  .running-text { flex: 1; min-width: 0; }
  .running-stage { font-size: 17px; font-weight: 600; letter-spacing: -.005em; }
  .running-stage::after {
    content: ""; display: inline-block; width: 1.6em;
    text-align: left; animation: dotskey 1.4s steps(4, end) infinite;
  }
  @keyframes dotskey { 0% { content: ""; } 25% { content: "."; } 50% { content: ".."; } 75% { content: "..."; } 100% { content: ""; } }
  .running-tip { margin-top: 4px; font-size: 13px; color: rgba(255,255,255,.78); transition: opacity .25s ease; }
  .running-meta { flex: 0 0 auto; text-align: right; }
  .running-elapsed { font-size: 12px; opacity: .8; font-variant-numeric: tabular-nums; }
  .running-count { font-size: 13px; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; }

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
    <a href="/flows" target="_blank">Flows ↗</a>
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
  url: string | null;
}

/**
 * Universal favicon URL via Google's s2 service. Works for any public
 * domain without needing per-site /favicon.ico probing. Falls back to
 * a tiny inline SVG dot when the URL is unparseable.
 */
/**
 * Build the live "View current page" URL. The pattern is always
 *   `<canonical_url>/<page_type>/<slug>`
 * with `canonical_url` coming straight from `projects.canonical_url`
 * (it bakes in any per-client subdomain, e.g. feeds.trussed.ai vs
 * achengineering.com/feeds). Falls back to `<projects.url>/feeds`
 * for legacy rows that don't have canonical_url populated.
 */
function buildPublishedUrl(project: ProjectRow, pageType: string, slug: string | null): string | null {
  if (!slug) return null;
  let base = (project.canonical_url ?? "").trim();
  if (!base) {
    const fallback = (project.url ?? "").replace(/\/+$/, "");
    if (!fallback) return null;
    base = `${fallback}/feeds`;
  }
  base = base.replace(/\/+$/, "");
  return `${base}/${pageType}/${slug}`;
}

/**
 * Format an ISO timestamp as IST ("Asia/Kolkata") for display in the
 * recent-runs list. Returns "—" for missing / unparseable inputs so
 * the column never renders an awkward "Invalid Date" cell. Uses
 * Intl.DateTimeFormat directly so the conversion happens in the
 * server's locale-independent stdlib path (no Date.toLocaleString
 * locale-dependent surprises).
 */
function formatIst(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  // Example output: "13 May 2026, 14:32 IST"
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${fmt.format(d)} IST`;
}

function faviconFor(rawUrl: string | null | undefined): string {
  const u = (rawUrl ?? "").trim();
  if (!u) return FAVICON_FALLBACK;
  try {
    const host = new URL(u).host || u;
    return `https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(host)}`;
  } catch {
    return FAVICON_FALLBACK;
  }
}
const FAVICON_FALLBACK =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><circle cx='8' cy='8' r='6' fill='%23cbd5e1'/></svg>`,
  );

// In-process cache for the featured-client name lookup. The names rarely
// change and the projects.id query was the dominant cost on home (5
// round trips × ~150ms = 750ms). 10-minute TTL is plenty for an
// internal tool; a process restart re-warms it in one query each.
let CLIENT_PICKER_CACHE: { entries: ClientPickerEntry[]; expiresAt: number } | null = null;
const CLIENT_PICKER_TTL_MS = 10 * 60 * 1000;

async function loadClientPickerEntries(): Promise<ClientPickerEntry[]> {
  const now = Date.now();
  if (CLIENT_PICKER_CACHE && CLIENT_PICKER_CACHE.expiresAt > now) {
    return CLIENT_PICKER_CACHE.entries;
  }
  const out = await Promise.all(
    CLIENTS.map(async (c) => {
      try {
        const p = await lookupProjectById(c.projectId);
        return { slug: c.slug, projectId: c.projectId, name: p?.name ?? c.slug, url: p?.url ?? null };
      } catch {
        return { slug: c.slug, projectId: c.projectId, name: c.slug, url: null };
      }
    }),
  );
  CLIENT_PICKER_CACHE = { entries: out, expiresAt: now + CLIENT_PICKER_TTL_MS };
  return out;
}

interface RecentRunSummary {
  manifest: string;
  client: string;
  client_name: string | null;
  project_id: string;
  /** Live project URL (for the favicon). Best-effort; null when DB lookup fails. */
  client_url: string | null;
  started_at: string;
  finished_at: string | null;
  ok: number;
  failed: number;
  /** Total rows the run was scheduled to process; null for very old manifests. */
  total: number | null;
  /** Images successfully Applied-to-S3 for this run (sidecar). */
  applied: number;
  /** "blog" / "service+category" etc, comma/+-joined when multiple. */
  page_types: string | null;
  /** "regen" (subprocess Generate run) or "upload" (operator drop). */
  mode: "regen" | "upload";
  /** Email decoded from the bearer JWT the operator used to start
   * the run. Null when the run was created without a token in the
   * Authorization header (legacy runs, or operator hadn't pasted
   * their token before clicking Generate). */
  started_by_email: string | null;
  csv: string | null;
  html: string | null;
  run_id: string | null;
}

async function loadRecentRuns(limit = 6): Promise<RecentRunSummary[]> {
  const dir = runOutDir();
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
      const runId = typeof j.run_id === "string" ? j.run_id : null;
      // total_rows landed in the manifest schema fairly recently; for
      // older manifests, fall back to ok+failed (the final summary
      // counts every row that was processed end-to-end). If even that
      // is absent, we'll render "—" so it's honest about being legacy.
      const total = typeof j.total_rows === "number"
        ? j.total_rows
        : (typeof j.summary?.ok === "number" || typeof j.summary?.failed === "number")
          ? (j.summary?.ok ?? 0) + (j.summary?.failed ?? 0)
          : null;
      const applied = runId ? await loadAppliedCount(runId) : 0;
      out.push({
        manifest: n,
        client: j.client ?? "",
        client_name: j.client_name ?? null,
        project_id: j.project_id ?? "",
        client_url: typeof j.client_url === "string" ? j.client_url : null,
        started_at: j.started_at ?? "",
        finished_at: j.finished_at ?? null,
        ok: j.summary?.ok ?? 0,
        failed: j.summary?.failed ?? 0,
        total,
        applied,
        page_types: typeof j.page_type === "string" ? j.page_type : Array.isArray(j.page_type) ? j.page_type.join("+") : null,
        mode: j.mode === "upload" ? "upload" : "regen",
        started_by_email: runId ? (await loadRunMeta(runId)).started_by_email : null,
        csv: csvPath,
        html: htmlPath,
        run_id: runId,
      });
    } catch {
      /* skip corrupt manifest */
    }
  }
  // Backfill missing client_url from the projects table — capped to a
  // single batch DB call. Cached so repeat home renders pay nothing.
  await backfillRecentRunUrls(out);
  return out;
}

const RECENT_URL_CACHE = new Map<string, string | null>();
async function backfillRecentRunUrls(rows: RecentRunSummary[]): Promise<void> {
  const need = rows.filter((r) => !r.client_url && r.project_id && !RECENT_URL_CACHE.has(r.project_id));
  if (need.length === 0) {
    for (const r of rows) {
      if (!r.client_url && RECENT_URL_CACHE.has(r.project_id)) r.client_url = RECENT_URL_CACHE.get(r.project_id) ?? null;
    }
    return;
  }
  await Promise.all(
    need.map(async (r) => {
      try {
        const p = await lookupProjectById(r.project_id);
        const url = p?.url ?? null;
        RECENT_URL_CACHE.set(r.project_id, url);
        r.client_url = url;
      } catch {
        RECENT_URL_CACHE.set(r.project_id, null);
      }
    }),
  );
  for (const r of rows) {
    if (!r.client_url && RECENT_URL_CACHE.has(r.project_id)) r.client_url = RECENT_URL_CACHE.get(r.project_id) ?? null;
  }
}

async function homePage(res: ServerResponse) {
  let envOk = true;
  try {
    loadEnv();
  } catch {
    envOk = false;
  }
  // Run the (sometimes-slow) project-name lookup and the recent-runs
  // disk read in parallel — they're independent.
  const [featured, recent] = await Promise.all([
    envOk
      ? loadClientPickerEntries()
      : Promise.resolve(CLIENTS.map((c) => ({ slug: c.slug, projectId: c.projectId, name: c.slug }))),
    envOk ? loadRecentRuns(200) : Promise.resolve([] as RecentRunSummary[]),
  ]);
  const featuredJson = JSON.stringify(featured);
  const RUNS_PER_TAB = 50;
  // page-index per row so we can split them client-side into 4 tabs
  // without re-rendering. Search-across-all is the default behaviour
  // (filter spans every row regardless of active tab).
  const recentRows = recent
    .map((r, i) => {
      const pageIdx = Math.floor(i / RUNS_PER_TAB); // 0..3
      const istLabel = formatIst(r.started_at);
      // status pill — running / failed / partial / ok / pending-apply
      const statusKey = !r.finished_at
        ? "running"
        : r.failed > 0 && r.ok > 0
          ? "partial"
          : r.failed > 0
            ? "failed"
            : "ok";
      const statusPill = statusKey === "running"
        ? `<span class="pill infographic">running</span>`
        : statusKey === "partial"
          ? `<span class="pill external" title="some images failed in this run">${r.failed} failed · ${r.ok} ok</span>`
          : statusKey === "failed"
            ? `<span class="pill external">${r.failed} failed</span>`
            : `<span class="pill internal">${r.ok} ok</span>`;
      const totalLabel = r.total != null ? String(r.total) : "—";
      const regeneratedLabel = (r.ok || r.failed) ? String(r.ok) : "—";
      const appliedPct = r.ok > 0 ? Math.round((r.applied / r.ok) * 100) : 0;
      // Apply-state classification:
      //   full    — every regenerated image was also applied to S3
      //   partial — some applied, some still pending
      //   none    — nothing applied yet
      // The full case gets a left-edge green stripe + chip in the row
      // so a glance at the table shows "this run is fully published".
      const applyState = r.ok > 0 && r.applied >= r.ok
        ? "full"
        : r.applied > 0
          ? "partial"
          : "none";
      const appliedInner = applyState === "full"
        ? `<span class="has all" title="all ${r.applied} regenerated images uploaded to S3">${r.applied}<span class="check">✓</span></span>`
        : applyState === "partial"
          ? `<span class="has" title="${r.applied} of ${r.ok} regenerated images uploaded to S3 (${appliedPct}%)">${r.applied}</span>`
          : `<span class="none">0</span>`;
      const fav = `<img src="${esc(faviconFor(r.client_url))}" alt="" class="fav" loading="lazy">`;
      const displayName = r.client_name ?? r.client;
      const nameInner = `${fav}<span>${esc(displayName)}</span>`;
      const pageTypeInner = r.page_types ? esc(r.page_types) : "—";
      const typeLabel = r.mode === "upload" ? "Upload" : "Generate";
      const typeIcon = r.mode === "upload" ? "↑" : "↻";
      const typeChip = `<span class="run-type-chip run-type-${r.mode}" title="${r.mode === "upload" ? "Operator-uploaded replacement images" : "Replicate-generated images"}">${typeIcon} ${typeLabel}</span>`;
      // Render just the local-part of the email (before "@") in the
      // cell — full email lives in the title attribute on hover. Keeps
      // the column compact and readable. Falls back to "—" when no
      // token was attached when the run started.
      const runByDisplay = r.started_by_email
        ? `<span class="run-by" title="${esc(r.started_by_email)}">${esc(r.started_by_email.split("@")[0] ?? r.started_by_email)}</span>`
        : `<span class="run-by run-by-empty" title="No bearer token was attached when this run was started">—</span>`;
      const searchKey = [displayName, r.page_types, typeLabel, r.started_by_email].filter(Boolean).join(" ").toLowerCase();
      const linkOpen = r.run_id ? `<a href="/runs/${esc(r.run_id)}" class="recent-link">` : `<span class="recent-link">`;
      const linkClose = r.run_id ? `</a>` : `</span>`;
      const rowOnClick = r.run_id ? ` onclick="location='/runs/${esc(r.run_id)}'"` : "";
      return `
<tr class="recent-row apply-${applyState}" data-search="${esc(searchKey)}" data-status="${statusKey}" data-applied="${r.applied > 0 ? "1" : "0"}" data-apply-state="${applyState}" data-mode="${r.mode}" data-page="${pageIdx}"${rowOnClick}>
  <td class="client">${linkOpen}${nameInner}${linkClose}</td>
  <td class="run-type-cell">${linkOpen}${typeChip}${linkClose}</td>
  <td class="run-by-cell">${linkOpen}${runByDisplay}${linkClose}</td>
  <td class="pt">${linkOpen}${pageTypeInner}${linkClose}</td>
  <td class="started">${linkOpen}<span class="ts-ist">${esc(istLabel)}</span>${linkClose}</td>
  <td class="num">${linkOpen}${totalLabel}${linkClose}</td>
  <td class="num">${linkOpen}${regeneratedLabel}${linkClose}</td>
  <td class="applied-cell">${linkOpen}${appliedInner}${linkClose}</td>
  <td>${linkOpen}${statusPill}${linkClose}</td>
</tr>`;
    })
    .join("");
  // Tab metadata for the client-side switcher. Each tab covers a
  // contiguous slice of 50 rows in newest-first order. Search
  // queries span ALL rows regardless of which tab is active; the
  // tab only governs which rows are visible when no filter is set.
  const totalRuns = recent.length;
  const tabCount = Math.min(4, Math.ceil(totalRuns / RUNS_PER_TAB) || 1);
  const tabsBar = totalRuns > RUNS_PER_TAB
    ? `<div class="recent-tabs" id="recent-tabs">
        ${Array.from({ length: tabCount }, (_, i) => {
          const start = i * RUNS_PER_TAB + 1;
          const end = Math.min((i + 1) * RUNS_PER_TAB, totalRuns);
          const active = i === 0 ? ' aria-selected="true" class="active"' : '';
          return `<button type="button" role="tab" data-tab="${i}"${active} onclick="switchRecentTab(${i})">${start}–${end}</button>`;
        }).join("")}
      </div>`
    : "";

  sendHtml(res, 200, shell("Home", `
<section class="hero">
  <div class="hero-inner">
    <h1 class="hero-h">${esc(APP_TITLE)}</h1>
    <p class="hero-sub">Bulk-generate replacement images for any published page — blog, service, or category. Pick a client, choose page types, choose images, generate, review, apply.</p>
    <form id="import-form" onsubmit="onContinue(event)" autocomplete="off">
      <div class="hero-search">
        <div class="combobox" id="combo">
          <!-- Single field: the picked card (when present) renders
               INSIDE this wrapper next to the input so the search bar
               itself never disappears. The × on the card clears it. -->
          <div class="combo-field">
            <div class="combo-chip" id="combo-chip" hidden>
              <img class="fav" id="combo-chip-fav" alt="">
              <span id="combo-chip-name"></span>
              <button type="button" class="combo-chip-x" onclick="clearComboPick(event)" title="Clear selection" aria-label="Clear">×</button>
            </div>
            <input type="text" id="client-input" placeholder="Search a client — name, URL, or project_id" autocomplete="off">
          </div>
          <span class="arrow">▾</span>
          <div class="menu" id="combo-menu"></div>
        </div>
        <input type="hidden" id="client-slug">
        <input type="hidden" id="client-project-id">
        <input type="hidden" id="client-url">
        <button class="primary hero-btn" type="submit" id="import-btn" disabled>Continue →</button>
      </div>
      <p class="combo-error" id="combo-error" hidden>Only one client can be selected. Clear the current one first.</p>
      <p class="hero-hint">A handful of featured clients have their <code>graphic_token</code> pre-saved (loads instantly). Any other project is extracted on the fly — adds ~30 seconds to the one-time import.</p>
    </form>
  </div>
</section>

${recent.length > 0 ? `
<section class="card" style="padding:0;margin-top:18px">
  <div class="recent-toolbar">
    <h2>Recent runs</h2>
    <span class="count-chip" id="recent-count">${recent.length}</span>
    <input type="search"
           id="recent-search"
           placeholder="Filter by client or page type…"
           autocomplete="off"
           oninput="filterRecentRuns()">
    <select id="recent-status-filter" onchange="filterRecentRuns()" title="Status filter">
      <option value="">All statuses</option>
      <option value="running">Running</option>
      <option value="ok">Completed</option>
      <option value="partial">Partial</option>
      <option value="failed">Failed</option>
    </select>
    <select id="recent-applied-filter" onchange="filterRecentRuns()" title="Apply state">
      <option value="">All apply state</option>
      <option value="1">Has applies</option>
      <option value="0">Not yet applied</option>
    </select>
    <select id="recent-mode-filter" onchange="filterRecentRuns()" title="Run type">
      <option value="">All types</option>
      <option value="regen">↻ Generate</option>
      <option value="upload">↑ Upload</option>
    </select>
  </div>
  ${tabsBar}
  <div style="overflow-x:auto">
    <table class="cluster-list recent-runs">
      <thead>
        <tr>
          <th>Client</th>
          <th>Type</th>
          <th title="Operator email decoded from the bearer JWT they used to start the run">Run by</th>
          <th>Page type</th>
          <th>Started</th>
          <th class="num" title="Total images the run was scheduled to process">Total</th>
          <th class="num" title="Images successfully regenerated / awaiting upload">Regen</th>
          <th class="num" title="Images uploaded to S3 from this run (Apply count)">Applied</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody id="recent-tbody">${recentRows}</tbody>
    </table>
  </div>
  <div id="recent-empty" class="sub" style="display:none;padding:16px 18px;text-align:center">No runs match the filters.</div>
  <script>
    // Combined client-side filter — name/page_type substring + status
    // pill match + applied-state flag. All three AND together.
    // Tab behaviour:
    //   - When NO filter is active, only the rows belonging to the
    //     currently-active tab (data-page === activeTab) are shown.
    //     This pages 200 runs into 4 tabs of 50.
    //   - When ANY filter is set (search / status / apply-state),
    //     the tab restriction is dropped — matches span every row
    //     across every tab so search-across-all works naturally.
    let __recentActiveTab = 0;
    function switchRecentTab(idx) {
      __recentActiveTab = idx;
      const buttons = document.querySelectorAll('#recent-tabs button');
      buttons.forEach((b) => {
        const isActive = Number(b.dataset.tab) === idx;
        b.classList.toggle('active', isActive);
        if (isActive) b.setAttribute('aria-selected', 'true');
        else b.removeAttribute('aria-selected');
      });
      filterRecentRuns();
    }
    function filterRecentRuns() {
      const needle = (document.getElementById('recent-search').value || '').toLowerCase().trim();
      const statusF = document.getElementById('recent-status-filter').value;
      const appliedF = document.getElementById('recent-applied-filter').value;
      const modeF = (document.getElementById('recent-mode-filter') || {}).value || '';
      const rows = document.querySelectorAll('#recent-tbody tr.recent-row');
      const filtered = !!(needle || statusF || appliedF || modeF);
      let visible = 0;
      for (const tr of rows) {
        const okSearch = !needle || (tr.dataset.search || '').includes(needle);
        const okStatus = !statusF || tr.dataset.status === statusF;
        const okApplied = !appliedF || tr.dataset.applied === appliedF;
        const okMode = !modeF || tr.dataset.mode === modeF;
        // Tab only restricts when no other filter is active.
        const okTab = filtered || Number(tr.dataset.page || 0) === __recentActiveTab;
        const hit = okSearch && okStatus && okApplied && okMode && okTab;
        tr.style.display = hit ? '' : 'none';
        if (hit) visible++;
      }
      const total = rows.length;
      document.getElementById('recent-count').textContent = filtered ? (visible + ' / ' + total) : total;
      document.getElementById('recent-empty').style.display = (filtered && visible === 0) ? 'block' : 'none';
    }
    // Initial paint: show only the first tab's rows.
    if (document.getElementById('recent-tbody')) filterRecentRuns();
  </script>
</section>` : `
<section class="card" style="margin-top:18px;text-align:center;padding:32px">
  <div class="sub">No runs yet. Pick a client above to get started.</div>
</section>`}

<!-- How-to flowchart — single horizontal row. Each step is a chip
     with a short title + one-line description so the strip is
     self-explanatory without needing a tooltip. -->
<section class="card howto" style="margin-top:18px">
  <div class="howto-head">
    <h2 style="margin:0">How it works</h2>
  </div>
  <ol class="howto-steps">
    <li><span class="howto-num">1</span><div><div class="howto-label">Pick client</div><div class="howto-sub">Search by name or URL.</div></div></li>
    <li><span class="howto-num">2</span><div><div class="howto-label">Page types</div><div class="howto-sub">Blog, service, or category.</div></div></li>
    <li><span class="howto-num">3</span><div><div class="howto-label">Select images</div><div class="howto-sub">Tick clusters and images.</div></div></li>
    <li><span class="howto-num">4</span><div><div class="howto-label">Generate</div><div class="howto-sub">Claude + Replicate produce them.</div></div></li>
    <li><span class="howto-num">5</span><div><div class="howto-label">Review</div><div class="howto-sub">Zoom, compare, or regenerate.</div></div></li>
    <li><span class="howto-num">6</span><div><div class="howto-label">Apply</div><div class="howto-sub">Pushes the new image live.</div></div></li>
  </ol>
</section>

<!-- Page-type chooser modal (opens on Continue) -->
<div class="drawer-overlay" id="pt-overlay" onclick="closePtModal(event)" style="z-index:80"></div>
<div id="pt-modal" class="pt-modal" role="dialog" aria-modal="true">
  <header style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">
    <h3 id="pt-title" style="margin:0;font-size:15px;font-weight:600;flex:1">Choose page types</h3>
    <button class="ghost" onclick="hidePtModal()">×</button>
  </header>
  <div class="body" style="padding:18px 20px">
    <div class="sub" style="margin-bottom:12px">Only published pages are loaded. Pick the types you want to work on; you can change this later.</div>
    <div id="pt-loading" class="pt-loading"><span class="spinner"></span> Counting published pages…</div>
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
function faviconUrlForUi(rawUrl) {
  const u = (rawUrl || '').trim();
  if (!u) return ${JSON.stringify(FAVICON_FALLBACK)};
  try {
    const host = new URL(u).host || u;
    return 'https://www.google.com/s2/favicons?sz=32&domain=' + encodeURIComponent(host);
  } catch { return ${JSON.stringify(FAVICON_FALLBACK)}; }
}
const inp = document.getElementById('client-input');
const hidden = document.getElementById('client-slug');
const hiddenPid = document.getElementById('client-project-id');
const hiddenUrl = document.getElementById('client-url');
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
    for (const c of featured) items.push({ kind: 'opt', name: c.name, slug: c.slug, projectId: c.projectId, url: c.url, featured: true });
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
      const fav = faviconUrlForUi(it.url);
      html += '<div class="opt' + (idx === activeIdx ? ' active' : '') + '" data-i="' + idx + '">' +
        '<div class="opt-name"><img class="fav" src="' + fav + '" alt="" loading="lazy">' +
          '<strong>' + (it.name || '(no name)') + '</strong>' + (it.featured ? ' <span class="featured-pill">★</span>' : '') + '</div>' +
        '<div class="pid">' + (it.slug ? it.slug + ' · ' : '') + it.projectId + (it.url ? ' · ' + it.url : '') + '</div>' +
      '</div>';
    }
  }
  menu.innerHTML = html;
}
function pick(i) {
  if (i < 0 || i >= visible.length) return;
  // Single-select rule: if a pick is already in place, flash the
  // error banner instead of swapping. The user has to clear with × first.
  if (hiddenPid.value) { showComboError(); return; }
  const c = visible[i];
  inp.value = '';
  hidden.value = c.slug || c.projectId; // slug for allow-list, project_id otherwise
  hiddenPid.value = c.projectId;
  hiddenName.value = c.name;
  hiddenUrl.value = c.url || '';
  setComboChip(c.name, c.url || '');
  combo.classList.remove('open');
  btn.disabled = false;
}
function setComboChip(name, url) {
  const chip = document.getElementById('combo-chip');
  const fav = document.getElementById('combo-chip-fav');
  const nm = document.getElementById('combo-chip-name');
  fav.src = faviconUrlForUi(url);
  nm.textContent = name;
  chip.hidden = false;
  // Keep the input in the DOM but blank out its placeholder so the
  // selection reads cleanly. Disable typing while a pick is active —
  // the only way forward is × or Continue.
  inp.value = '';
  inp.placeholder = '';
  inp.disabled = true;
}
function clearComboPick(ev) {
  if (ev) { ev.preventDefault(); ev.stopPropagation(); }
  document.getElementById('combo-chip').hidden = true;
  inp.disabled = false;
  inp.placeholder = 'Search a client — name, URL, or project_id';
  inp.value = '';
  hidden.value = ''; hiddenPid.value = ''; hiddenName.value = ''; hiddenUrl.value = '';
  btn.disabled = true;
  hideComboError();
  inp.focus();
  refresh('');
  combo.classList.add('open');
}
let comboErrorTimer = null;
function showComboError() {
  const el = document.getElementById('combo-error');
  if (!el) return;
  el.hidden = false;
  document.getElementById('combo-chip').classList.add('combo-chip-shake');
  if (comboErrorTimer) clearTimeout(comboErrorTimer);
  comboErrorTimer = setTimeout(() => {
    el.hidden = true;
    document.getElementById('combo-chip').classList.remove('combo-chip-shake');
  }, 2400);
}
function hideComboError() {
  const el = document.getElementById('combo-error');
  if (el) el.hidden = true;
  document.getElementById('combo-chip').classList.remove('combo-chip-shake');
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

  // Eager graphic_token extraction. Fires the moment the modal
  // opens so by the time the operator picks page types and clicks
  // Continue (~5–10s), the ~60s Firecrawl+Claude pass is well in
  // flight. Server coalesces (one extraction per slug at a time)
  // and no-ops when a token's already on disk, so this is safe to
  // fire unconditionally — featured clients pay nothing, ad-hoc
  // projects get a head start.
  fetch('/workspace/' + encodeURIComponent(slug) + '/token/extract', { method: 'POST' })
    .catch(() => { /* fire-and-forget; workspace polls status separately */ });

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
  // Workspace is multi-page-type now: ALL chosen types go into
  // ?selected= as a CSV. The workspace shows the union and the pills
  // act as toggles.
  const params = new URLSearchParams();
  params.set('selected', checks.join(','));
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
  slug: string | null;
  published_url: string | null;
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

  // Two-phase render for speed:
  //   1) Pre-fetch every blog cluster's S3 markdown in parallel
  //      (fills the shared cache so the parser is purely synchronous).
  //   2) ONE collectImageRecords call across all clusters — the
  //      media_registry batch lookup runs ONCE for the whole workspace
  //      instead of per-cluster.
  // For Sentinel (57 blog clusters), this drops workspace render from
  //  ~57 sequential SQL queries down to 1, and S3 fetches from
  //  serialised-by-worker to 12-way parallel.
  const stagingSubdomain = hasAwsCreds ? project.staging_subdomain : null;
  const s3Cache = buildS3Cache(stagingSubdomain);
  const t0 = Date.now();
  const cacheHits = s3Cache.size;
  await prefetchBlogMarkdowns(clusters, stagingSubdomain, s3Cache);
  syncToGlobalCache(s3Cache, stagingSubdomain);
  const tPrefetch = Date.now();
  const allRecords = await collectImageRecords(clusters, { stagingSubdomain, s3Cache });
  process.stderr.write(
    `workspace: render-data for ${clusters.length} clusters in ${Date.now() - t0}ms ` +
      `(prefetch ${tPrefetch - t0}ms, cache hits ${cacheHits}/${clusters.length})\n`,
  );
  const recordsByCluster: Record<string, ImageRecord[]> = {};
  for (const r of allRecords) {
    if (!recordsByCluster[r.cluster.id]) recordsByCluster[r.cluster.id] = [];
    recordsByCluster[r.cluster.id]!.push(r);
  }

  const payload: ClusterPayload[] = clusters.map((c) => {
    const recs = recordsByCluster[c.id] ?? [];
    const counts: Record<string, number> = {};
    for (const r of recs) counts[r.asset] = (counts[r.asset] ?? 0) + 1;
    const cover = recs.find((r) => r.asset === "cover" || r.asset === "service_h1" || r.asset === "category_industry");
    const publishedUrl = buildPublishedUrl(project!, c.page_type, c.slug);
    return {
      id: c.id,
      page_type: c.page_type,
      topic: c.topic ?? "(no topic)",
      slug: c.slug,
      published_url: publishedUrl,
      updated_at: c.updated_at ? c.updated_at.toISOString().slice(0, 10) : null,
      cover_url: cover?.previewUrl ?? null,
      total: recs.length,
      by_asset: counts,
      images: recs.map((r) => ({
        id: r.imageId,
        // Synthetic placeholders contain "/" — let the drawer flag
        // them visually so the operator knows the image_id won't map
        // to media_registry until a real ID is wired in.
        id_is_synthetic: typeof r.imageId === "string" && r.imageId.includes("/"),
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
      // Aspect-ratio class drives the placeholder/thumbnail dimensions
      // so service/category clusters render square and blog clusters
      // render 16:9 — matches what the regen pipeline will produce.
      const aspectClass = c.page_type === "blog" ? "ar-16x9" : "ar-1x1";
      const cover = c.cover_url
        ? `<img src="${esc(c.cover_url)}" alt="" loading="lazy" class="${aspectClass}">`
        : `<div class="placeholder ${aspectClass}"></div>`;
      const pills = Object.entries(c.by_asset)
        .map(([k, v]) => `<span class="pill ${esc(k)}">${esc(k)}: ${v}</span>`)
        .join(" ");
      // Build the published-page URL from project root_domain +
      // page_type + slug. Pattern (per spec):
      //   https://<root_domain>/feeds/<page_type>/<slug>
      // Falls back gracefully when slug isn't set on the cluster row.
      const publishedUrl = buildPublishedUrl(project!, c.page_type, c.slug);
      return `
<tr class="cluster-row" data-cluster-id="${esc(c.id)}" data-page-type="${esc(c.page_type)}" data-topic="${esc(c.topic.toLowerCase())}" onclick="rowClick(event, '${esc(c.id)}')">
  <td onclick="event.stopPropagation()"><input type="checkbox" class="cluster-select" data-cluster-id="${esc(c.id)}" onclick="onClusterCheck('${esc(c.id)}', this.checked, event)"></td>
  <td class="topic">
    <div class="t">${esc(c.topic)}</div>
    <div class="cid"><span class="pill pt-${esc(c.page_type)}">${esc(c.page_type)}</span> <code>${esc(c.id)}</code> · ${esc(c.updated_at ?? "")}</div>
  </td>
  <td class="preview">${cover}</td>
  <td class="types"><div class="pills-wrap">${pills}</div></td>
  <td style="text-align:right" onclick="event.stopPropagation()">
    ${publishedUrl
      ? `<a class="btn btn-published" href="${esc(publishedUrl)}" target="_blank" rel="noopener">View current page →</a>`
      : `<span class="sub" style="font-size:11px">no slug</span>`}
  </td>
</tr>`;
    })
    .join("");

  // Pre-render Client info card
  function fmtJson(v: unknown): string {
    if (v == null) return "(empty)";
    try { return JSON.stringify(v, null, 2); } catch { return String(v); }
  }
  const logoUrls = (project.logo_urls ?? null) as Record<string, unknown> | null;
  // The "favicon" — small timestamped logo from projects.logo_urls.
  // Used only as the small badge next to the project name in the header.
  const faviconLogo = (logoUrls && typeof logoUrls === "object"
    ? (logoUrls.favicon ??
       logoUrls.primary_logo ??
       logoUrls.logo ??
       logoUrls.primaryLogo ??
       Object.values(logoUrls).find((v) => typeof v === "string" && (v as string).startsWith("http")))
    : null) as string | null | undefined;
  // The canonical brand logo (image-gen `image_input`). This is the
  // well-known asset/logo/logo.webp path per staging_subdomain — a real
  // logo file rather than a 16×16 favicon. Operators can override.
  const primaryLogo = project.staging_subdomain
    ? `https://file-host.link/website/${project.staging_subdomain}/assets/logo/logo.webp`
    : null;

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
  const allPageTypes: PageType[] = ["blog", "service", "category"];
  const currentSelected = selectedPageTypes && selectedPageTypes.size > 0
    ? new Set(allPageTypes.filter((pt) => selectedPageTypes.has(pt)))
    : new Set<PageType>(allPageTypes);

  // Pure toggle pills — no "active" concept. The cluster table shows
  // the union of every pill that's currently selected (a per-row
  // page_type pill keeps things distinguishable). Clicking a selected
  // pill removes it (unless it's the last one); clicking an
  // unselected pill adds it.
  const tabBtn = (pt: PageType, label: string) => {
    const isSelected = currentSelected.has(pt);
    let nextSelected: PageType[];
    if (isSelected) {
      const others = [...currentSelected].filter((t) => t !== pt) as PageType[];
      nextSelected = others.length > 0 ? others : [pt]; // last pill is pinned
    } else {
      nextSelected = [...currentSelected, pt] as PageType[];
    }
    const href = `/workspace/${esc(slug)}?selected=${nextSelected.join(",")}`;
    const stateClass = isSelected ? "active" : "unselected";
    return `<a class="page-tab ${stateClass}" href="${href}" title="${isSelected ? "click to remove" : "click to add"}">${label} <span class="ct">${pageTypeCounts[pt]}</span></a>`;
  };

  const body = `
${awsBanner}
<section class="card">
  <div style="display:flex;align-items:start;gap:16px">
    ${faviconLogo ? `<img src="${esc(faviconLogo)}" alt="" style="width:36px;height:36px;border-radius:6px;object-fit:contain;background:#fff;border:1px solid var(--border);padding:3px;flex:0 0 auto" onerror="this.style.display='none'">` : ""}
    <div style="flex:1">
      <h1>${esc(project.name ?? slug)}</h1>
      <div class="sub">
        ${clusters.length} pages across ${[...currentSelected].join(" + ")} · ${totalImages} images (${totalsBadges})
      </div>
      <div class="page-tabs" style="margin-top:10px;display:flex;gap:6px">
        ${allPageTypes.map((pt) => tabBtn(pt, pt[0]!.toUpperCase() + pt.slice(1))).join("")}
      </div>
    </div>
  </div>
</section>

<section class="card">
  <details open>
    <summary><h2 style="display:inline">Client information</h2></summary>
    <div class="sub" style="margin:8px 0 14px">Logo + graphic_token are the only inputs the regen pipeline reads. Everything else is just shown for context.</div>

    <!-- Logo: real preview + URL override + Save (auto-refreshes the
         preview on success so the operator sees the override take). -->
    <div style="display:flex;gap:18px;align-items:center;margin-bottom:14px">
      <div id="logo-preview-wrap" class="logo-preview-wrap">
        ${effectiveLogo
          ? `<img id="logo-preview" class="logo-preview" src="${esc(effectiveLogo)}" alt="logo" onclick="openLogoLightbox(this.src)" title="Click to expand">`
          : `<div id="logo-preview" class="logo-preview no-logo">no logo</div>`}
      </div>
      <form id="logo-form" onsubmit="saveLogo(event)" style="flex:1">
        <label style="font-size:12px;color:var(--ink-muted)">Logo URL (overrides the project's primary_logo) — image-gen reads this exact URL.</label>
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
      <h2 style="display:inline">Brand guidelines</h2>
    </summary>
    <div class="sub" style="margin:8px 0 10px">
      Free-text directives that get <strong>appended verbatim</strong> to every image-generation prompt as a top-priority block — they override any visual choice Claude would otherwise make. Saved under <code>graphic_token.additional_instructions</code>.
    </div>

    <form id="brand-form" onsubmit="saveBrand(event)">
      <label style="font-size:12px;color:var(--ink-muted)">Additional instructions (highest priority — passed verbatim to the image model)</label>
      <textarea id="brand-text" style="margin-top:4px" placeholder="(optional) e.g. Use deep navy + gold only. Avoid stock-photo people. Always include the brand mark in the footer.">${esc(brand)}</textarea>
      <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
        <button type="submit" class="primary">Save</button>
        <span id="brand-status" class="sub"></span>
      </div>
    </form>

    ${!savedToken || Object.keys(savedToken as Record<string, unknown>).length === 0
      ? `<div id="token-missing-banner" class="banner info" style="margin-top:16px">
           <div style="display:flex;align-items:center;gap:10px">
             <span class="spinner" aria-hidden="true"></span>
             <strong id="extract-state-label">Extracting <code>graphic_token</code> from the live site…</strong>
           </div>
           <div class="sub" style="margin-top:4px" id="extract-state-detail">
             ${project.url
               ? "We start this the moment you pick a project — it usually finishes within 30–60s. The page will auto-refresh as soon as it's ready."
               : "This project has no <code>url</code> set in the projects table — extraction can't run. Add one in the DB and reload."}
           </div>
           <div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
             <button class="primary" onclick="extractToken(event)" id="extract-token-btn"${project.url ? "" : ' disabled title="No project.url to scrape"'}>⚡ Extract now</button>
             <span class="sub" id="extract-status"></span>
           </div>
         </div>
         <script>
         // Auto-poll: every 4s, ask the server whether the token has
         // landed yet. As soon as it has, reload the page so the
         // freshly-saved file gets picked up by loadToken on the
         // server-side render. If the status endpoint reports a
         // recent failure, surface it.
         (function () {
           const slug = ${JSON.stringify(slug)};
           if (!${JSON.stringify(project.url ?? "")}) return; // can't extract
           // Kick off an extraction in case nobody else has (e.g.
           // operator landed via deep-link without going through the
           // home-page modal). The server coalesces, so this is a
           // no-op when one is already in flight.
           fetch('/workspace/' + encodeURIComponent(slug) + '/token/extract', { method: 'POST' })
             .catch(() => { /* polled separately below */ });
           let attempts = 0;
           const timer = setInterval(async () => {
             attempts++;
             try {
               const r = await fetch('/workspace/' + encodeURIComponent(slug) + '/token/status', { cache: 'no-store' });
               if (!r.ok) return;
               const j = await r.json();
               if (j.has_token) {
                 clearInterval(timer);
                 const lbl = document.getElementById('extract-state-label');
                 if (lbl) lbl.textContent = 'Token ready — refreshing…';
                 setTimeout(() => window.location.reload(), 300);
                 return;
               }
               if (j.last_error && !j.extracting) {
                 const lbl = document.getElementById('extract-state-label');
                 const det = document.getElementById('extract-state-detail');
                 if (lbl) lbl.textContent = 'Extraction failed';
                 if (det) det.textContent = j.last_error;
                 const banner = document.getElementById('token-missing-banner');
                 if (banner) { banner.classList.remove('info'); banner.classList.add('err'); }
                 const spin = banner ? banner.querySelector('.spinner') : null;
                 if (spin) spin.remove();
                 clearInterval(timer);
                 return;
               }
               // Give up automatic polling after ~5 min of no result;
               // operator can still click "Extract now".
               if (attempts > 75) clearInterval(timer);
             } catch (_) { /* network blip; try again next tick */ }
           }, 4000);
         })();
         </script>`
      : ""}

    <details style="margin-top:14px">
      <summary class="sub"><strong>graphic_token (advanced — editable JSON)</strong></summary>
      <form id="token-form" onsubmit="saveToken(event)" style="margin-top:8px">
        <textarea id="token-text" class="json-edit" spellcheck="false">${esc(fmtJson(savedToken))}</textarea>
        <div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button type="submit" class="primary">Save token</button>
          <button type="button" onclick="resetToken()">Reset</button>
          <button type="button" id="reextract-btn" onclick="extractToken(event)"${project.url ? "" : ' disabled title="No project.url to scrape"'}>⚡ Re-extract from site</button>
          <span id="token-status" class="sub"></span>
        </div>
      </form>
    </details>
  </details>
</section>
<script>
const TOKEN_INITIAL = ${JSON.stringify(JSON.stringify(savedToken ?? {}, null, 2))};
function resetToken() {
  const t = document.getElementById('token-text');
  if (t) t.value = TOKEN_INITIAL;
  const s = document.getElementById('token-status');
  if (s) s.textContent = '';
}
async function extractToken(e) {
  if (e) e.preventDefault();
  // The same handler powers both the first-time banner button and the
  // "Re-extract from site" button nested in the advanced view.
  // Whichever fired the click is what we update; status falls back to
  // a status node if present.
  const btn = (e && e.currentTarget) || document.getElementById('extract-token-btn') || document.getElementById('reextract-btn');
  const status = document.getElementById('extract-status') || document.getElementById('token-status');
  const originalLabel = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Extracting…';
  }
  if (status) { status.style.color = ''; status.textContent = 'scraping + asking Claude — can take up to 60s'; }
  try {
    const r = await fetch('/workspace/' + encodeURIComponent(${JSON.stringify(slug)}) + '/token/extract', {
      method: 'POST'
    });
    if (!r.ok) throw new Error(await r.text());
    if (status) status.textContent = 'done — reloading…';
    setTimeout(() => window.location.reload(), 500);
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = originalLabel || '⚡ Extract graphic_token now'; }
    if (status) { status.style.color = 'var(--err)'; status.textContent = 'failed: ' + err.message; }
  }
}
async function saveToken(e) {
  e.preventDefault();
  const status = document.getElementById('token-status');
  status.style.color = '';
  const raw = document.getElementById('token-text').value;
  let parsed;
  try { parsed = JSON.parse(raw); } catch (err) {
    status.style.color = 'var(--err)';
    status.textContent = 'invalid JSON: ' + err.message;
    return;
  }
  status.textContent = 'saving…';
  try {
    const r = await fetch('/workspace/' + encodeURIComponent(${JSON.stringify(slug)}) + '/token', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: parsed })
    });
    if (!r.ok) throw new Error(await r.text());
    status.textContent = 'saved ✓';
    setTimeout(() => { status.textContent = ''; }, 1500);
  } catch (err) {
    status.style.color = 'var(--err)';
    status.textContent = 'error: ' + err.message;
  }
}
</script>

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
        <th style="width:84px">Image</th>
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

<!-- Sticky bottom action bar — Generate runs the live pipeline
     (Portkey + Replicate). No dry-run / mock path. -->
<div class="action-bar">
  <div class="stats">
    <strong id="bar-img-count">0</strong> images selected across <strong id="bar-cluster-count">0</strong> clusters
  </div>
  <div class="right">
    <button id="bar-upload-btn" onclick="openUploadRun()" disabled title="Skip the generation step — operator drops client-supplied replacement images for each picked slot, then runs the same Apply pipeline.">↑ Upload replacements</button>
    <button class="primary" id="bar-generate-btn" onclick="openGenerateConfirm()" disabled title="Review prompts before running the generation pipeline.">Generate →</button>
  </div>
</div>

<!-- Generate confirmation modal — opens when the operator clicks
     "Generate →". Lets them preview (and optionally edit, per-run
     only) each system prompt that will be used in the upcoming run. -->
<div class="cmp-overlay" id="gen-overlay" onclick="genBackdrop(event)">
  <div class="cmp-modal" role="dialog" aria-modal="true" style="max-width:900px">
    <header class="cmp-head">
      <strong>Are you sure you want to generate images?</strong>
      <span class="sub" id="gen-summary" style="margin-left:auto"></span>
      <button class="cmp-x" onclick="closeGenerateConfirm()" aria-label="Close">×</button>
    </header>
    <div style="padding:14px 18px 6px 18px">
      <div class="sub" id="gen-help">
        Each prompt below is collapsed by default. Expand to view; edit if you want a one-off tweak just for this run. Edits are <strong>not</strong> saved back to the repo — they only apply to the images you're about to generate.
      </div>
    </div>
    <div id="gen-prompts" style="padding:0 18px 6px 18px;overflow-y:auto;flex:1">
      <div class="sub" id="gen-prompts-loading">Loading prompts…</div>
    </div>
    <footer style="padding:12px 18px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end;align-items:center">
      <span class="sub" id="gen-overrides-count" style="margin-right:auto"></span>
      <button type="button" onclick="closeGenerateConfirm()">Cancel</button>
      <button type="button" class="primary" id="gen-submit-btn" onclick="genConfirmSubmit()">Generate →</button>
    </footer>
  </div>
</div>
`;

  const scripts = `<script>
const SLUG = ${JSON.stringify(slug)};
// Comma-separated list of every selected page_type — sent to /regen
// so the CLI lists clusters across all of them, not just one.
const SELECTED_PAGE_TYPES = ${JSON.stringify([...currentSelected].join(","))};
const CLUSTERS = ${JSON.stringify(payload)};
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

function applyFilters() {
  const q = (document.getElementById('topic-filter').value || '').toLowerCase().trim();
  let n = 0;
  for (const tr of allRows()) {
    const topic = tr.dataset.topic ?? '';
    const cid = tr.dataset.clusterId ?? '';
    const visible = !q || topic.includes(q) || cid.includes(q);
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
  document.getElementById('bar-generate-btn').disabled = imgs === 0;
  const upBtn = document.getElementById('bar-upload-btn');
  if (upBtn) upBtn.disabled = imgs === 0;
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
    // Map asset → aspect-ratio class so the preview / placeholder box
    // matches the size of the image the regen pipeline will produce.
    //   cover                  → 16:9
    //   thumbnail              → 1:1
    //   service_h1/body, category_industry → 1:1
    //   everything else        → 16:9 (infographic / inline)
    const arClass = (img.asset === 'cover' || img.asset === 'infographic' || img.asset === 'internal' || img.asset === 'external' || img.asset === 'generic')
      ? 'pre-16x9'
      : 'pre-1x1';
    const previewHtml = previewSrc
      ? '<img src="' + previewSrc + '" alt="" loading="lazy" onclick="openLightbox(event, this.src, ' + captionAttr + ')">'
      : '<div class="ph">' + placeholderText + '</div>';
    cardsHtml.push(
      '<label class="img-card ' + arClass + (checked ? ' selected' : '') + '" data-img-id="' + img.id + '">' +
        '<input type="checkbox" class="img-toggle" ' + (checked ? 'checked' : '') + ' onchange="onImgToggle(this)">' +
        '<div class="pre">' + previewHtml + '</div>' +
        '<div>' +
          '<div class="meta-row">' +
            '<span class="pill ' + img.asset + '">' + img.asset + ' · ' + img.aspect + '</span>' +
            // Empty / synthetic ids get a clear visual marker so the
            // operator can spot a parse miss (e.g. Sentinel <Image>
            // emitted without imageId, or shape-A fallback to a
            // placeholder hash) without having to dig into logs.
            (img.id && !img.id_is_synthetic
              ? '<code title="canonical image_id from ' + img.source + '">' + img.id + '</code>'
              : '<code style="background:#fef3c7;color:#92400e;" title="' + (img.id ? 'synthetic placeholder — does not map to media_registry' : 'no image_id parsed from this record') + '">' + (img.id || '⟨no image_id⟩') + '</code>') +
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
function openLogoLightbox(src) {
  if (!src) return;
  openLightbox(null, src, 'logo · click anywhere or press Esc to close');
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const gen = document.getElementById('gen-overlay');
    if (gen && gen.classList.contains('open')) { closeGenerateConfirm(); return; }
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
      const cacheBuster = newSrc + (newSrc.includes('?') ? '&' : '?') + '_=' + Date.now();
      wrap.innerHTML = '<img id="logo-preview" class="logo-preview" src="' + cacheBuster + '" alt="logo" onclick="openLogoLightbox(this.src)" title="Click to expand">';
    } else {
      wrap.innerHTML = '<div id="logo-preview" class="logo-preview no-logo">no logo</div>';
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

// ── Generate-confirmation modal ──
// Replaces the old direct-submit path. Operator clicks Generate →
// modal opens with a per-prompt-group collapsible editor → on submit
// we POST /regen with both the selected items AND any per-run prompt
// overrides the operator typed. The server writes the overrides to a
// JSON temp file and the CLI re-reads it (matches how
// extra-instructions-file / prompt-override-file already work).

// Maps asset_type to its underlying prompt group. Mirrors
// promptGroupFor() in src/buildPrompt.ts so the modal can show only
// the groups whose prompts will actually run.
function promptGroupForAsset(asset) {
  if (asset === 'cover' || asset === 'thumbnail') return 'cover';
  if (asset === 'infographic') return 'infographic';
  if (asset === 'internal' || asset === 'external'
      || asset === 'service_h1' || asset === 'service_body'
      || asset === 'category_industry') return 'page';
  if (asset === 'generic') return 'generic';
  return 'generic';
}

// Selection summary computed at modal-open time: how many images,
// across how many clusters, mapped to which prompt groups.
function summariseSelection() {
  let imgs = 0, cls = 0;
  const groupsSeen = new Set();
  for (const [cid, set] of selection.entries()) {
    if (!set || set.size === 0) continue;
    cls++;
    imgs += set.size;
    const cluster = clusterById(cid);
    if (!cluster) continue;
    const wantedIds = new Set(set);
    for (const img of cluster.images) {
      if (!wantedIds.has(img.id)) continue;
      groupsSeen.add(promptGroupForAsset(img.asset));
    }
  }
  return { imgs, cls, groups: [...groupsSeen] };
}

// We render every group the API surfaces and let the operator browse
// any of them; the ones in groupsInUse get a "used by this run"
// pill so the relevant prompts stand out at a glance.
let GENERATE_DEFAULTS = null; // populated on first modal open: [{group,label,system,user},…]

async function openGenerateConfirm() {
  const { imgs, cls, groups } = summariseSelection();
  if (imgs === 0) return;
  document.getElementById('gen-summary').textContent =
    imgs + ' image' + (imgs === 1 ? '' : 's') +
    ' across ' + cls + ' cluster' + (cls === 1 ? '' : 's');

  const overlay = document.getElementById('gen-overlay');
  overlay.classList.add('open');

  const host = document.getElementById('gen-prompts');
  if (!GENERATE_DEFAULTS) {
    host.innerHTML = '<div class="sub" id="gen-prompts-loading"><span class="spinner"></span> Loading prompts…</div>';
    try {
      const r = await fetch('/api/prompts');
      const j = await r.json();
      GENERATE_DEFAULTS = (j && j.groups) || [];
    } catch (err) {
      host.innerHTML = '<div class="banner err">Failed to load prompts: ' + (err && err.message ? err.message : String(err)) + '</div>';
      return;
    }
  }
  renderGeneratePrompts(groups);
}
function genBackdrop(ev) { if (ev.target === ev.currentTarget) closeGenerateConfirm(); }
function closeGenerateConfirm() { document.getElementById('gen-overlay').classList.remove('open'); }

function renderGeneratePrompts(usedGroups) {
  const host = document.getElementById('gen-prompts');
  const used = new Set(usedGroups);
  // Sort: used groups first, then the rest.
  const sorted = GENERATE_DEFAULTS.slice().sort((a, b) => {
    const au = used.has(a.group), bu = used.has(b.group);
    return (bu ? 1 : 0) - (au ? 1 : 0);
  });
  host.innerHTML = sorted.map((p) => {
    const isUsed = used.has(p.group);
    return ''
      + '<details class="gen-group" data-group="' + p.group + '" ' + (isUsed ? '' : '') + '>'
      + '  <summary>'
      + '    <strong>' + escapeHtmlBasic(p.label) + '</strong>'
      + (isUsed ? ' <span class="pill internal" style="font-size:10px;margin-left:6px">used by this run</span>'
                : ' <span class="sub" style="margin-left:6px">(not used by this run)</span>')
      + '    <span class="sub gen-edit-flag" style="margin-left:8px;display:none;color:var(--brand)">edited</span>'
      + '  </summary>'
      + '  <div style="padding:10px 12px 12px">'
      + '    <label style="font-size:11.5px;color:var(--ink-muted)">System prompt</label>'
      + '    <textarea class="gen-system json-edit" data-default="' + escapeHtmlBasic(p.system) + '" oninput="genFlagEdit(this)">' + escapeHtmlBasic(p.system) + '</textarea>'
      + '    <div style="margin-top:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">'
      + '      <button type="button" class="ghost" onclick="genResetSystem(this)">Reset to default</button>'
      + '      <span class="sub gen-status"></span>'
      + '    </div>'
      + '  </div>'
      + '</details>';
  }).join('');
  recountGenOverrides();
}
function escapeHtmlBasic(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function genFlagEdit(ta) {
  const det = ta.closest('details');
  if (!det) return;
  const flag = det.querySelector('.gen-edit-flag');
  const dirty = ta.value !== ta.dataset.default;
  if (flag) flag.style.display = dirty ? 'inline' : 'none';
  recountGenOverrides();
}
function genResetSystem(btn) {
  const det = btn.closest('details');
  if (!det) return;
  const ta = det.querySelector('.gen-system');
  if (!ta) return;
  // The dataset.default attribute went through HTML entity encoding;
  // textContent of a temp div decodes it back to the original string.
  const decoder = document.createElement('div');
  decoder.innerHTML = ta.dataset.default;
  ta.value = decoder.textContent || '';
  genFlagEdit(ta);
}
function recountGenOverrides() {
  let n = 0;
  for (const ta of document.querySelectorAll('#gen-prompts .gen-system')) {
    const decoder = document.createElement('div');
    decoder.innerHTML = ta.dataset.default;
    const def = decoder.textContent || '';
    if (ta.value !== def) n++;
  }
  const lbl = document.getElementById('gen-overrides-count');
  lbl.textContent = n === 0 ? '' : n + ' prompt' + (n === 1 ? '' : 's') + ' overridden for this run';
}

async function genConfirmSubmit() {
  const items = [];
  for (const [cid, set] of selection.entries()) {
    if (!set || set.size === 0) continue;
    items.push({ cluster_id: cid, image_ids: [...set] });
  }
  if (items.length === 0) return;

  // Collect only the prompt groups the operator actually edited. An
  // unmodified textarea is identity-equal to its default — we ship
  // those as "no override".
  const overrides = {};
  for (const det of document.querySelectorAll('#gen-prompts .gen-group')) {
    const ta = det.querySelector('.gen-system');
    if (!ta) continue;
    const decoder = document.createElement('div');
    decoder.innerHTML = ta.dataset.default;
    const def = decoder.textContent || '';
    if (ta.value !== def && ta.value.trim().length > 0) {
      overrides[det.dataset.group] = { system: ta.value };
    }
  }

  const fd = new FormData();
  fd.set('client', SLUG);
  fd.set('page_type', SELECTED_PAGE_TYPES);
  for (const it of items) {
    fd.append('cluster_id', it.cluster_id);
    for (const id of it.image_ids) fd.append('image_id', id);
  }
  fd.set('provider', 'replicate');
  if (Object.keys(overrides).length > 0) {
    fd.set('prompt_overrides', JSON.stringify(overrides));
  }

  const btn = document.getElementById('gen-submit-btn');
  const resetBtn = () => { if (btn) { btn.disabled = false; btn.innerHTML = 'Generate →'; } };
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Submitting…'; }
  // Best-effort: forward the operator's per-tab bearer token so the
  // server can stamp the run-meta sidecar with "started_by_email".
  // No token = no header = sidecar shows "—" in the recent-runs
  // table. Doesn't gate /regen itself (generation only needs
  // Replicate/Portkey env creds; the bearer is for Apply only).
  const wsTok = (function () { try { return sessionStorage.getItem('gw_repoint_bearer_v1') || ''; } catch (_e) { return ''; } })();
  const fetchOpts = wsTok
    ? { method: 'POST', body: fd, headers: { 'Authorization': 'Bearer ' + wsTok } }
    : { method: 'POST', body: fd };
  // Hard guards on the network call so a transient failure (Railway
  // redeploy mid-click, 502 from the edge proxy, browser offline)
  // never leaves the submit button stuck in 'Submitting…' state.
  // Previously the await threw and the function silently exited
  // before reaching the reset line.
  try {
    const r = await fetch('/regen', fetchOpts);
    if (r.redirected) { window.location.href = r.url; return; }
    if (!r.ok) {
      const errText = (await r.text().catch(() => '')).slice(0, 500);
      alert('Generate failed (HTTP ' + r.status + ').' + (errText ? '\\n\\n' + errText : '\\n\\nThe server returned an error. If a deploy was in progress, refresh and try again.'));
      resetBtn();
      return;
    }
    const t = await r.text().catch(() => '');
    alert(t || 'regen submitted');
    resetBtn();
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    alert('Generate failed: ' + msg + '\\n\\nIf the server is mid-redeploy, wait ~30 seconds and try again.');
    resetBtn();
  }
}

// Legacy entry point — anything still wired to runRegen() now goes
// through the confirm modal first.
function runRegen() { openGenerateConfirm(); }

// Upload-replacement entry point — POSTs the current selection to
// /upload-run/start (which creates a manifest + skeleton CSV) and
// redirects to the new run page where each card exposes a drop
// zone instead of a regenerated preview. Strictly parallel to
// runRegen — never invokes the generation pipeline.
async function openUploadRun() {
  const items = [];
  for (const [cid, set] of selection.entries()) {
    if (!set || set.size === 0) continue;
    items.push({ cluster_id: cid, image_ids: [...set] });
  }
  if (items.length === 0) return;
  const total = items.reduce((n, it) => n + it.image_ids.length, 0);
  if (!confirm('Start an UPLOAD run for ' + total + ' images? You\\'ll drag-and-drop a replacement file per slot on the next page, then click Apply to push them through the same upload→repoint pipeline as a regenerated run.')) return;
  const btn = document.getElementById('bar-upload-btn');
  if (btn) { btn.disabled = true; btn.textContent = '… creating run'; }
  try {
    // Forward the operator's per-tab bearer (when present) so the
    // server can stamp "started_by_email" into the run-meta sidecar
    // for the recent-runs "Run by" column. Not required to start
    // the run; absence just leaves the column blank.
    const upTok = (function () { try { return sessionStorage.getItem('gw_repoint_bearer_v1') || ''; } catch (_e) { return ''; } })();
    const upHeaders = upTok
      ? { 'content-type': 'application/json', 'Authorization': 'Bearer ' + upTok }
      : { 'content-type': 'application/json' };
    const r = await fetch('/upload-run/start', {
      method: 'POST', headers: upHeaders,
      body: JSON.stringify({ client: SLUG, page_type: SELECTED_PAGE_TYPES, items })
    });
    const j = await r.json();
    if (!r.ok || !j.run_id) throw new Error(j.error || ('HTTP ' + r.status));
    // Land on the prepare stage — focused dropzone view with a
    // Continue button. Operator can switch to the Apply view at any
    // time via the "Skip — go to Apply" link in the bottom bar, or
    // by dropping the ?stage= param from the URL.
    window.location.href = (j.url || ('/runs/' + j.run_id)) + '?stage=prepare';
  } catch (err) {
    alert('failed to create upload run: ' + (err && err.message ? err.message : err));
    if (btn) { btn.disabled = false; btn.textContent = '↑ Upload replacements'; }
  }
}

refreshTotals();
</script>`;

  sendHtml(res, 200, shell(`workspace · ${slug}`, body, scripts, esc(slug)));
}

// ────────────────────────────────────────────────────────────────────────
// POST /workspace/:slug/brand — save brand guidelines
// ────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────
// Apply endpoints — the production apply pipeline lives in src/apply.ts
// and matches stormbreaker's behaviour (3 WebP variants → media_registry
// row → page_info mutation). These handlers are thin: parse + lookup
// rows + delegate.
//
// AUTH — TODO (engineering): no token / Cognito check today. See §4 of
// docs/apply-api-blueprint.md for the three options. Until we pick
// one, /api/apply/* is reachable by anyone who can reach the server.
// On Railway that's everyone on the public domain; tighten before
// pointing real operators at it for production data outside trusted
// engineering review.
// ────────────────────────────────────────────────────────────────────────

async function readApplyBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────
// In-memory bearer-token store (operator pastes a fresh 1h token in the
// run-page panel; held in process memory until it expires or the
// process restarts — never written to disk, never echoed back in full).
// Decision: server-side in-memory, no auth gate (operator's call).
// ────────────────────────────────────────────────────────────────────────
// Token storage model — per-OPERATOR, not per-process.
//
// History: tokens used to live in a process-global API_TOKEN, which
// leaked between concurrent operators. The cure is to keep the token
// on the operator's own machine (sessionStorage in their browser tab)
// and send it as an `Authorization: Bearer <jwt>` header on every
// request that needs it. The server reads from the header per-request
// and never holds state for any operator.
//
// /api/token POST still exists, but only to validate the token (decode
// expiry, return the status the client uses to label the chip). It
// does NOT store anything server-side. Likewise /api/token/clear is
// now purely a no-op confirmation — clearing happens in the browser.
//
// /api/token/status no longer "remembers" anything; it answers
// "is the token you sent valid?" based on the Authorization header.
function decodeJwt(tok: string): { exp: number | null; email: string | null } {
  try {
    const p = JSON.parse(Buffer.from(tok.split(".")[1] ?? "", "base64").toString("utf8")) as {
      exp?: unknown;
      email?: unknown;
    };
    return {
      exp: typeof p.exp === "number" ? p.exp : null,
      email: typeof p.email === "string" ? p.email : null,
    };
  } catch {
    return { exp: null, email: null };
  }
}

/** Read the bearer token from the per-request Authorization header.
 *  Strips the "Bearer " prefix; returns "" when absent. */
function readBearerToken(req: IncomingMessage): string {
  const raw = req.headers.authorization || req.headers.Authorization;
  if (!raw) return "";
  const s = String(Array.isArray(raw) ? raw[0] : raw).trim();
  if (s.toLowerCase().startsWith("bearer ")) return s.slice(7).trim();
  return s;
}

function tokenStatusFromHeader(req: IncomingMessage) {
  const tok = readBearerToken(req);
  if (!tok) return { present: false as const };
  const { exp, email } = decodeJwt(tok);
  const expired = exp != null && exp * 1000 < Date.now();
  return {
    present: true as const,
    expired,
    email,
    expires_at: exp ? new Date(exp * 1000).toISOString() : null,
  };
}

function requireApiToken(req: IncomingMessage): { ok: true; token: string } | { ok: false; error: string } {
  const tok = readBearerToken(req);
  if (!tok) {
    return { ok: false, error: "no bearer token set — paste a fresh token in the token panel first (your token lives only in this browser tab, never on the server)" };
  }
  const { exp } = decodeJwt(tok);
  if (exp != null && exp * 1000 < Date.now()) {
    return {
      ok: false,
      error: `your token expired at ${new Date(exp * 1000).toISOString()} — paste a fresh one`,
    };
  }
  return { ok: true, token: tok };
}

async function tokenSetHandler(req: IncomingMessage, res: ServerResponse) {
  // Kept for backward-compat with clients that POST the token; we
  // simply validate-and-echo. Nothing is stored.
  const body = (await readApplyBody(req)) as { token?: string } | null;
  if (!body || typeof body.token !== "string" || !body.token.trim())
    return sendJson(res, 400, { error: "body.token required" });
  const tok = body.token.trim();
  const { exp, email } = decodeJwt(tok);
  if (exp != null && exp * 1000 < Date.now())
    return sendJson(res, 400, {
      error: `that token is already expired (exp ${new Date(exp * 1000).toISOString()}) — fetch a fresh one from https://platform.gushwork.ai/api/auth/token`,
    });
  return sendJson(res, 200, {
    ok: true,
    status: { present: true, expired: false, email, expires_at: exp ? new Date(exp * 1000).toISOString() : null },
  });
}

async function tokenClearHandler(_req: IncomingMessage, res: ServerResponse) {
  // Server doesn't hold tokens; the operator clears via their browser.
  return sendJson(res, 200, { ok: true, status: { present: false } });
}

/**
 * Best-effort: pull the operator's email out of the Authorization
 * JWT for stamping into the run manifest / sidecar. Returns null
 * when no token is present, the JWT can't be decoded, or the JWT
 * has no email claim. Never throws — generation/upload starts must
 * not be blocked by absent or malformed tokens.
 */
function readOperatorEmail(req: IncomingMessage): string | null {
  const tok = readBearerToken(req);
  if (!tok) return null;
  const { email } = decodeJwt(tok);
  return email || null;
}

/**
 * Per-run metadata sidecar at <runOutDir>/run-meta-<runId>.json.
 * Captures who started the run (decoded from the bearer JWT they
 * sent with /regen or /upload-run/start). Read by loadRecentRuns
 * so the recent-runs table can show a "Run by" column.
 *
 * Why a sidecar and not the manifest: the regen manifest is written
 * by the subprocess (cli.ts), which doesn't see the HTTP request.
 * Passing the operator email as a CLI arg would work, but a tiny
 * server-side sidecar keeps the change strictly additive and
 * doesn't muddy the CLI contract.
 */
async function writeRunMeta(
  runId: string,
  meta: { started_by_email: string | null; started_by_set_at: string },
): Promise<void> {
  if (!runId) return;
  try {
    const p = path.join(runOutDir(), `run-meta-${runId}.json`);
    await fs.writeFile(p, JSON.stringify(meta) + "\n", "utf8");
  } catch (err) {
    process.stderr.write(`writeRunMeta: ${runId} failed: ${(err as Error).message}\n`);
  }
}

async function loadRunMeta(runId: string): Promise<{ started_by_email: string | null }> {
  if (!runId) return { started_by_email: null };
  try {
    const p = path.join(runOutDir(), `run-meta-${runId}.json`);
    const raw = await fs.readFile(p, "utf8");
    const j = JSON.parse(raw) as { started_by_email?: unknown };
    return { started_by_email: typeof j.started_by_email === "string" ? j.started_by_email : null };
  } catch {
    return { started_by_email: null };
  }
}

// ────────────────────────────────────────────────────────────────────────
// upload → repoint pipeline (replaces the old in-place S3 apply).
// Each scope (image / cluster / run) gathers the run CSV rows, uploads
// them through the Gushwork media API, then repoints page_info.
// dry_run still UPLOADS (new ids are needed to preview the repoint) —
// only the page_info PUT is skipped. The UI states this explicitly.
// ────────────────────────────────────────────────────────────────────────
async function resolveRunRows(
  runId: string,
): Promise<{ rows: CsvRowParsed[] } | { error: string; code: number }> {
  let state = RUNS.get(runId) ?? null;
  if (!state) state = await tryReconstructRunFromDisk(runId);
  if (!state || !state.csvPath) {
    return { error: `Run ${runId} not found — no in-memory state and no manifest on disk. The container may have been redeployed and the run is older than its retention window, or the manifest was pruned.`, code: 404 };
  }
  const r = await readRunCsv(state.csvPath);
  if ("error" in r) {
    // Surface the real reason so the operator sees "csv missing on
    // disk" / "csv malformed" instead of the misleading "image_id not
    // in csv" downstream. Path drift after a Railway redeploy lands
    // here (manifest's absolute csv path points at the old container
    // filesystem); tryReconstructRunFromDisk now re-resolves basenames
    // against runOutDir(), so this branch only fires when the CSV is
    // genuinely missing from the volume.
    return { error: r.error, code: r.code === "ENOENT" ? 410 : 500 };
  }
  return { rows: r.rows };
}

async function runRepointPipeline(
  req: IncomingMessage,
  res: ServerResponse,
  scopeRows: CsvRowParsed[],
  dryRun: boolean,
  scopeLabel: string,
  runId?: string,
) {
  const tk = requireApiToken(req);
  if (!tk.ok) return sendJson(res, 400, { error: tk.error });
  if (scopeRows.length === 0) return sendJson(res, 404, { error: "no rows in scope" });

  const up = await uploadRows(scopeRows, {
    csvPath: "",
    token: tk.token,
    refine: true,
    concurrency: 4,
    failFast: false,
  });
  const rep = await repointMappingRows(up.mapping, {
    token: tk.token,
    apply: !dryRun,
    concurrency: 4,
    failFast: false,
  });
  // Shape the response to the EXISTING client contract (per-image
  // `results[]` with `image_id_old/new`, `steps[]`, `ok`, `dry_run`,
  // `reason`) so the run-page rendering keeps working unchanged. Each
  // image's outcome = its upload step + its cluster's repoint step.
  const ocByCluster = new Map(rep.outcomes.map((o) => [o.cluster_id, o]));
  const results = up.mapping.map((m) => {
    const oc = ocByCluster.get(m.cluster_id);
    const uploaded = m.upload_status === "uploaded";
    const repOk = oc ? oc.status === "applied" || oc.status === "dry-run" : false;
    const ok = uploaded && repOk;
    const uploadStep = {
      n: 1,
      name: "upload image → Gushwork media API",
      status: uploaded ? "ok" : m.upload_status === "uploaded_unconfirmed" ? "skipped" : "error",
      detail: uploaded
        ? `new image_id=${m.new_image_id} key=${m.new_refined_key}`
        : `${m.upload_status}: ${m.upload_error || "see logs"}`,
    };
    const repStep = {
      n: 2,
      name: dryRun ? "repoint page_info (DRY-RUN — no write)" : "repoint page_info (PUT)",
      status: !oc
        ? "error"
        : oc.status === "applied"
          ? "ok"
          : oc.status === "dry-run"
            ? "skipped"
            : "error",
      detail: oc ? oc.reason : "no cluster outcome (upload failed?)",
    };
    // Reason priority: row-level upload error wins over cluster
    // rollup. The cluster gate says things like "1/6 image(s) not
    // 'uploaded' — skip-whole-cluster", which is useless for
    // diagnosing the actual row failure. Surface the specific
    // upload_error (HTTP code, expired URL, etc.) so the operator
    // sees the actionable message. Falls back to the cluster
    // outcome's reason for rows where upload succeeded but the
    // cluster as a whole was skipped or failed.
    const rowReason = !uploaded && m.upload_error
      ? m.upload_error
      : oc
        ? oc.reason
        : uploadStep.detail;
    return {
      ok,
      dry_run: dryRun,
      image_id_old: m.old_image_id,
      image_id_new: m.new_image_id,
      key_prefix: m.new_refined_key,
      reason: ok ? "" : (rowReason || `apply failed for ${m.old_image_id} (no upstream error message — check server logs)`),
      asset_type: m.asset_type,
      cluster_id: m.cluster_id,
      steps: [uploadStep, repStep],
    };
  });
  const okN = results.filter((r) => r.ok).length;
  // Persist a sidecar so the recent-runs view can show how many
  // images have actually been pushed to S3 via this run. We count
  // every successful UPLOAD (the persistent side-effect — bytes on
  // S3) regardless of dry_run, because dry-run still uploads; only
  // the page_info repoint PUT is gated on dry_run. Each id is set-
  // unioned in the sidecar so re-applies don't double-count.
  if (runId) {
    const uploadedIds = up.mapping
      .filter((m) => m.upload_status === "uploaded")
      .map((m) => m.old_image_id)
      .filter(Boolean);
    if (uploadedIds.length > 0) void recordAppliedImages(runId, uploadedIds);
  }
  const payload = {
    ok: results.every((r) => r.ok),
    dry_run: dryRun,
    scope: scopeLabel,
    summary: { total: results.length, applied: okN, failed: results.length - okN },
    results,
    // Single-scope (one image) clients read these top-level fields.
    ...(results.length === 1 ? results[0] : {}),
  };
  return sendJson(res, 200, payload);
}

/**
 * Sidecar persistence for applied image_ids per run. One file per run
 * at `<runOutDir>/applied-<runId>.json` shaped:
 *   { image_ids: ["id1", "id2", …], updated_at: "<iso>" }
 *
 * Read by loadRecentRuns to surface the "applied" count alongside
 * ok/failed/total in the home-page recent-runs table. Survives
 * redeploys because it lives on the same persistent volume as the
 * manifest. Best-effort writes — a sidecar failure never blocks an
 * apply response.
 */
async function recordAppliedImages(runId: string, imageIds: string[]): Promise<void> {
  if (!runId || imageIds.length === 0) return;
  const p = path.join(runOutDir(), `applied-${runId}.json`);
  let existing: string[] = [];
  try {
    const raw = await fs.readFile(p, "utf8");
    const j = JSON.parse(raw) as { image_ids?: unknown };
    if (Array.isArray(j.image_ids)) existing = j.image_ids.filter((x): x is string => typeof x === "string");
  } catch { /* first write or unreadable — start fresh */ }
  const set = new Set(existing);
  for (const id of imageIds) set.add(id);
  const payload = { image_ids: [...set], updated_at: new Date().toISOString() };
  try {
    await fs.writeFile(p, JSON.stringify(payload) + "\n", "utf8");
  } catch (err) {
    process.stderr.write(`recordAppliedImages: ${p} write failed: ${(err as Error).message}\n`);
  }
}

async function loadAppliedCount(runId: string): Promise<number> {
  const p = path.join(runOutDir(), `applied-${runId}.json`);
  try {
    const raw = await fs.readFile(p, "utf8");
    const j = JSON.parse(raw) as { image_ids?: unknown };
    return Array.isArray(j.image_ids) ? j.image_ids.length : 0;
  } catch { return 0; }
}

/**
 * POST /api/repoint/image (alias /api/apply/image) — upload ONE image
 * via the Gushwork media API, then repoint page_info. Body:
 * { run_id, image_id, dry_run }. dry_run still uploads.
 */
async function applyImageHandler(req: IncomingMessage, res: ServerResponse) {
  const body = (await readApplyBody(req)) as { run_id?: string; image_id?: string; dry_run?: boolean } | null;
  if (!body) return sendJson(res, 400, { error: "invalid JSON body" });
  const runId = body.run_id ?? "";
  const imageId = body.image_id ?? "";
  const dryRun = body.dry_run === true;
  if (!runId || !imageId) return sendJson(res, 400, { error: "run_id and image_id required" });
  const tk = requireApiToken(req);
  if (!tk.ok) return sendJson(res, 400, { error: tk.error });

  const r = await resolveRunRows(runId);
  if ("error" in r) return sendJson(res, r.code, { error: r.error });
  const scope = r.rows.filter((x) => x.image_id === imageId);
  if (scope.length === 0) {
    // Distinguish "CSV present but row missing" from "CSV had zero
    // rows (parsed empty or wrong shape)" so the operator can tell
    // a data mismatch from a path/parse failure.
    if (r.rows.length === 0) {
      return sendJson(res, 410, { error: `Run ${runId} CSV parsed as empty — file may be truncated or schema drifted. Re-run Generate or check the manifest's csv path on the volume.` });
    }
    return sendJson(res, 404, { error: `image_id "${imageId}" is not in run ${runId} (${r.rows.length} rows checked). Likely cause: the cluster's thumbnail / page_info was updated by Stormbreaker between Generate and Apply, so the live image_id no longer matches what was recorded at Generate time. Re-import the cluster and Generate again.` });
  }
  return runRepointPipeline(req, res, scope, dryRun, `image ${imageId}`, runId);
}

/**
 * POST /api/repoint/cluster (alias /api/apply/cluster) — upload every
 * image in ONE cluster, then repoint that cluster's page_info in a
 * single atomic PUT. Body: { run_id, cluster_id, dry_run }.
 */
async function applyClusterHandler(req: IncomingMessage, res: ServerResponse) {
  const body = (await readApplyBody(req)) as { run_id?: string; cluster_id?: string; dry_run?: boolean } | null;
  if (!body) return sendJson(res, 400, { error: "invalid JSON body" });
  const runId = body.run_id ?? "";
  const clusterId = body.cluster_id ?? "";
  const dryRun = body.dry_run === true;
  if (!runId || !clusterId) return sendJson(res, 400, { error: "run_id and cluster_id required" });
  const tk = requireApiToken(req);
  if (!tk.ok) return sendJson(res, 400, { error: tk.error });

  const r = await resolveRunRows(runId);
  if ("error" in r) return sendJson(res, r.code, { error: r.error });
  const scope = r.rows.filter((x) => x.cluster_id === clusterId);
  if (scope.length === 0)
    return sendJson(res, 404, { error: `no rows for cluster ${clusterId} in run ${runId}` });
  return runRepointPipeline(req, res, scope, dryRun, `cluster ${clusterId}`, runId);
}

/**
 * POST /api/repoint/run (alias /api/apply/run) — upload + repoint
 * every cluster in the run. Body: { run_id, dry_run }.
 */
async function applyRunHandler(req: IncomingMessage, res: ServerResponse) {
  const body = (await readApplyBody(req)) as { run_id?: string; dry_run?: boolean } | null;
  if (!body) return sendJson(res, 400, { error: "invalid JSON body" });
  const runId = body.run_id ?? "";
  const dryRun = body.dry_run === true;
  if (!runId) return sendJson(res, 400, { error: "run_id required" });
  const tk = requireApiToken(req);
  if (!tk.ok) return sendJson(res, 400, { error: tk.error });

  const r = await resolveRunRows(runId);
  if ("error" in r) return sendJson(res, r.code, { error: r.error });
  if (r.rows.length === 0) return sendJson(res, 404, { error: `no rows in run ${runId} csv` });
  return runRepointPipeline(req, res, r.rows, dryRun, `run ${runId}`, runId);
}

// ────────────────────────────────────────────────────────────────────────
// Revert: restore page_info from the per-cluster backups repoint wrote.
// Dry-run (default) needs no token (no API call). --apply PUTs the
// prior page_info and needs the token. Response is shaped to the same
// client modal contract (results[] with steps[]).
// ────────────────────────────────────────────────────────────────────────
async function runRevertAndRespond(
  req: IncomingMessage,
  res: ServerResponse,
  backupFiles: string[],
  dryRun: boolean,
  scopeLabel: string,
) {
  let token = "";
  if (!dryRun) {
    const tk = requireApiToken(req);
    if (!tk.ok) return sendJson(res, 400, { error: tk.error });
    token = tk.token;
  }
  if (backupFiles.length === 0)
    return sendJson(res, 404, { error: `no repoint backups found for ${scopeLabel}` });

  const { outcomes } = await revertBackups(backupFiles, {
    token,
    apply: !dryRun,
    concurrency: 4,
    failFast: false,
  });
  const results = outcomes.map((o) => ({
    ok: o.status === "applied" || o.status === "dry-run" || o.status === "noop",
    dry_run: dryRun,
    image_id_old: o.cluster_id,
    image_id_new: "",
    key_prefix: o.backup_file,
    reason: o.reason,
    cluster_id: o.cluster_id,
    steps: [
      {
        n: 1,
        name: dryRun ? "revert page_info (DRY-RUN — no write)" : "revert page_info (PUT)",
        status:
          o.status === "applied" || o.status === "dry-run"
            ? "ok"
            : o.status === "noop"
              ? "skipped"
              : "error",
        detail: o.reason + (o.prerevert_snapshot ? ` | snapshot: ${o.prerevert_snapshot}` : ""),
      },
    ],
  }));
  const okN = results.filter((r) => r.ok).length;
  return sendJson(res, 200, {
    ok: results.every((r) => r.ok),
    dry_run: dryRun,
    scope: scopeLabel,
    summary: { total: results.length, applied: okN, failed: results.length - okN },
    results,
    ...(results.length === 1 ? results[0] : {}),
  });
}

/** POST /api/revert/cluster — restore ONE cluster's latest backup. */
async function revertClusterHandler(req: IncomingMessage, res: ServerResponse) {
  const body = (await readApplyBody(req)) as { cluster_id?: string; dry_run?: boolean } | null;
  if (!body) return sendJson(res, 400, { error: "invalid JSON body" });
  const clusterId = body.cluster_id ?? "";
  const dryRun = body.dry_run === true;
  if (!clusterId) return sendJson(res, 400, { error: "cluster_id required" });
  const dir = path.resolve(process.cwd(), DEFAULT_BACKUPS_DIR);
  const f = await latestBackupForCluster(dir, clusterId);
  if (!f) return sendJson(res, 404, { error: `no repoint backup for cluster ${clusterId}` });
  return runRevertAndRespond(req, res, [f], dryRun, `cluster ${clusterId}`);
}

/** POST /api/revert/run — restore the latest backup of every cluster
 * in a run that has one. */
async function revertRunHandler(req: IncomingMessage, res: ServerResponse) {
  const body = (await readApplyBody(req)) as { run_id?: string; dry_run?: boolean } | null;
  if (!body) return sendJson(res, 400, { error: "invalid JSON body" });
  const runId = body.run_id ?? "";
  const dryRun = body.dry_run === true;
  if (!runId) return sendJson(res, 400, { error: "run_id required" });
  const r = await resolveRunRows(runId);
  if ("error" in r) return sendJson(res, r.code, { error: r.error });
  const clusterIds = [...new Set(r.rows.map((x) => x.cluster_id).filter(Boolean))];
  const dir = path.resolve(process.cwd(), DEFAULT_BACKUPS_DIR);
  const files: string[] = [];
  for (const cid of clusterIds) {
    const f = await latestBackupForCluster(dir, cid);
    if (f) files.push(f);
  }
  return runRevertAndRespond(req, res, files, dryRun, `run ${runId}`);
}

async function regenOneHandler(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let runId = "", imageId = "", clusterId = "", customInstructions = "";
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
      run_id?: string; image_id?: string; cluster_id?: string; custom_instructions?: string;
    };
    runId = body.run_id ?? "";
    imageId = body.image_id ?? "";
    clusterId = body.cluster_id ?? "";
    customInstructions = (body.custom_instructions ?? "").trim();
  } catch {
    return sendJson(res, 400, { error: "invalid JSON body" });
  }
  if (!imageId) return sendJson(res, 400, { error: "image_id required" });
  if (!runId) return sendJson(res, 400, { error: "run_id required" });

  const parent = RUNS.get(runId);
  if (!parent) return sendJson(res, 404, { error: `run ${runId} not found` });

  // Read the parent CSV row once and pull out everything we need:
  // cluster_id (if not supplied), the prompt_used we want to reuse
  // (saves the Portkey round-trip), and any prediction_id from the
  // prior attempt (lets us recover a prediction that completed after
  // our 280s polling budget expired).
  let promptOverrideFile: string | undefined;
  let resumePredictionId: string | undefined;
  if (parent.csvPath) {
    const rows = await readRunCsvOrEmpty(parent.csvPath);
    const row = rows.find((r) => r.image_id === imageId);
    if (row) {
      if (!clusterId) clusterId = row.cluster_id;
      if (row.prompt_used && row.prompt_used.trim().length > 0) {
        const tmpDir = runOutDir();
        const fname = `prompt-override-${imageId.replace(/[^a-zA-Z0-9._-]/g, "_")}-${Date.now()}.txt`;
        promptOverrideFile = path.join(tmpDir, fname);
        await fs.mkdir(tmpDir, { recursive: true });
        await fs.writeFile(promptOverrideFile, row.prompt_used, "utf8");
      }
      const pid = row.prediction_id?.trim();
      if (pid) resumePredictionId = pid;
    }
  }
  if (!clusterId) return sendJson(res, 400, { error: "cluster_id required (and not found in parent CSV)" });

  // Operator-supplied one-off instructions for this regen only — the
  // workspace UI's "Regenerate (custom instructions)" flow. Written
  // to a temp file so multi-line text + odd characters don't go
  // through argv shell-escaping. The CLI merges this into the
  // per-record top-priority directive block at generation time.
  let extraInstructionsFile: string | undefined;
  if (customInstructions.length > 0) {
    const tmpDir = runOutDir();
    const fname = `extra-${imageId.replace(/[^a-zA-Z0-9._-]/g, "_")}-${Date.now()}.txt`;
    extraInstructionsFile = path.join(tmpDir, fname);
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(extraInstructionsFile, customInstructions, "utf8");
  }

  // Resumption only makes sense when the regen is meant to be the
  // SAME image — custom instructions are a deliberate ask for a new
  // image, so we suppress the resume path in that case.
  const effectiveResumeId = customInstructions.length === 0 ? resumePredictionId : undefined;

  // Re-run the same CLI pipeline scoped to one image_id + cluster_id.
  // We reuse the parent's client/page_type so the subprocess loads the
  // identical graphic_token + project context.
  const child = startRegen({
    client: parent.client,
    clusterIds: [clusterId],
    imageIds: [imageId],
    dryRun: false,
    mock: false,
    useSavedToken: true,
    pageType: extractPageTypeFromArgs(parent.args),
    provider: extractProviderFromArgs(parent.args),
    promptOverrideFile,
    extraInstructionsFile,
    resumePredictionId: effectiveResumeId,
  });

  // Wait for the subprocess to finish, then read its CSV for the new URL.
  await new Promise<void>((resolve) => {
    if (child.done) return resolve();
    const onClose = () => resolve();
    child.proc?.once("close", onClose);
  });

  if (child.exitCode !== 0 || !child.csvPath) {
    return sendJson(res, 500, { error: `regen subprocess failed (exit ${child.exitCode})`, run_id: child.id });
  }
  const childRows = await readRunCsvOrEmpty(child.csvPath);
  const childRow = childRows.find((r) => r.image_id === imageId);
  if (!childRow || !childRow.image_url_new) {
    return sendJson(res, 500, { error: `no new image URL produced for ${imageId}`, run_id: child.id });
  }

  // CRITICAL: write the regenerated columns back into the PARENT
  // CSV row in place. Without this:
  //   Download   → still serves the pre-regen image (old bytes from
  //                parent's image_local_path).
  //   Apply to S3→ uploads the pre-regen image_url_new.
  //   ZIP        → archives the pre-regen image.
  //   Compare    → the "new" pane shows the pre-regen image
  //                (the card's <img src> is updated client-side, but
  //                the cmp modal also uses src so this part already
  //                worked — the others didn't).
  //
  // The parent CSV is the single source of truth for every read on
  // the runs page; mutating the matching row keeps Download/Apply/
  // ZIP semantically aligned with what the operator just saw.
  if (parent.csvPath) {
    try {
      await updateParentCsvRow(parent.csvPath, imageId, {
        image_url_new: childRow.image_url_new,
        image_local_path: childRow.image_local_path,
        prompt_used: childRow.prompt_used,
        prediction_id: childRow.prediction_id ?? "",
        generated_at_utc: childRow.generated_at_utc,
        status: "completed",
        error: "",
      });
    } catch (err) {
      process.stderr.write(
        `regenOne: parent CSV update failed for ${imageId} in ${parent.csvPath}: ${(err as Error).message}\n`,
      );
      // Continue — the UI still gets the new URL, but Download/Apply
      // on a refresh will still show the old one. Logged so we can
      // diagnose any persistence issue separately.
    }
  }

  sendJson(res, 200, { image_url_new: childRow.image_url_new, image_id: imageId, cluster_id: clusterId, run_id: child.id });
}

/**
 * Atomically rewrite a single row in a CSV in place. Used by the
 * single-image Regenerate flow to update the parent run's CSV with
 * the regenerated image's new URL / local path / prompt / prediction
 * id, so the rest of the runs page (Download, Apply, ZIP, Compare)
 * stays in sync.
 *
 * Implementation: read the whole CSV with csv-parse, mutate the
 * target row in memory, re-serialise with csv-stringify, write
 * atomically via tmp + rename. The CSV is bounded (50 runs × tens
 * of rows) so the full read/write is cheap. The atomic rename
 * means a crash mid-write leaves the original CSV intact.
 */
async function updateParentCsvRow(
  csvPath: string,
  imageId: string,
  patch: Partial<Record<string, string>>,
): Promise<void> {
  const { CSV_HEADER } = await import("./csv.js");
  const { stringify } = await import("csv-stringify/sync");

  const raw = await fs.readFile(csvPath, "utf8");
  const rows = csvParse(raw, { columns: true, skip_empty_lines: true }) as Array<
    Record<string, string>
  >;

  let touched = false;
  for (const r of rows) {
    if (r.image_id === imageId) {
      Object.assign(r, patch);
      touched = true;
      break;
    }
  }
  if (!touched) {
    process.stderr.write(
      `updateParentCsvRow: image_id=${imageId} not found in ${csvPath}\n`,
    );
    return;
  }

  // Normalise every row so every column from CSV_HEADER is present
  // as a string. csv-stringify writes header order from `columns`
  // and an explicit value list keeps shape stable even when the
  // source file pre-dates a column we added later (e.g. predicted_id).
  const normalised = rows.map((r) => {
    const out: Record<string, string> = {};
    for (const h of CSV_HEADER) out[h] = r[h] ?? "";
    return out;
  });
  const body = stringify(normalised, { header: true, columns: [...CSV_HEADER] });

  // Atomic write: tmp file in same dir, then rename. Rename is
  // atomic on POSIX, so concurrent reads of the parent CSV either
  // see the old version in full or the new version in full — never
  // a torn half-write.
  const tmp = csvPath + ".tmp-" + Date.now();
  await fs.writeFile(tmp, body, "utf8");
  await fs.rename(tmp, csvPath);
}

function extractPageTypeFromArgs(args: string[]): PageType | undefined {
  const i = args.indexOf("--page-type");
  if (i < 0) return undefined;
  const v = args[i + 1];
  return v === "service" || v === "category" || v === "blog" ? v : undefined;
}
function extractProviderFromArgs(args: string[]): string | undefined {
  const i = args.indexOf("--provider");
  return i >= 0 ? args[i + 1] : undefined;
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

/**
 * POST /workspace/:slug/token — overwrite graphic-tokens/<slug>.json
 * with operator-edited JSON. Body: { token: <object> }. Pre-validates
 * that the body is a JSON object (not an array, not a string).
 */
async function saveTokenHandler(req: IncomingMessage, res: ServerResponse, slug: string) {
  if (!resolveClient(slug)) return sendJson(res, 400, { error: "unknown client" });
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let token: unknown;
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { token?: unknown };
    token = body.token;
  } catch {
    return sendJson(res, 400, { error: "invalid JSON body" });
  }
  if (!token || typeof token !== "object" || Array.isArray(token)) {
    return sendJson(res, 400, { error: "token must be a JSON object" });
  }
  try {
    const { saveToken } = await import("./tokens.js");
    const tokenPath = await saveToken(slug, token as Record<string, unknown>);
    sendJson(res, 200, { ok: true, token_path: tokenPath });
  } catch (err) {
    sendJson(res, 500, { error: (err as Error).message });
  }
}

/**
 * In-memory tracker for in-flight token extractions. Lets the home
 * page kick off an extract optimistically when the operator opens
 * the page-type modal, and the workspace page poll for completion
 * without re-running the (expensive) Firecrawl+Portkey pipeline.
 *
 * Keyed by slug. Value is the running Promise so callers can await.
 * The entry is removed in `finally` regardless of success/failure.
 */
const EXTRACTING_TOKENS = new Map<string, Promise<{ tokenPath: string }>>();
const EXTRACT_ERRORS = new Map<string, { message: string; at: number }>(); // last failure per slug, ~5min retention
const EXTRACT_ERROR_TTL_MS = 5 * 60 * 1000;

function recordExtractError(slug: string, message: string): void {
  EXTRACT_ERRORS.set(slug, { message, at: Date.now() });
}
function consumeRecentExtractError(slug: string): string | null {
  const e = EXTRACT_ERRORS.get(slug);
  if (!e) return null;
  if (Date.now() - e.at > EXTRACT_ERROR_TTL_MS) { EXTRACT_ERRORS.delete(slug); return null; }
  return e.message;
}

/**
 * Start (or join) an extraction for a slug. Multiple callers in the
 * same window get the same Promise — only one Firecrawl + Portkey
 * pass runs at a time. Cheap GET status doesn't need this; only the
 * actual work-doing path coalesces.
 */
async function ensureExtractionInFlight(slug: string): Promise<{ tokenPath: string }> {
  const existing = EXTRACTING_TOKENS.get(slug);
  if (existing) return existing;
  // No-op if the token's already saved (featured clients ship one,
  // or a prior extraction already wrote one). Lets the home page
  // fire extract optimistically without burning Firecrawl/Portkey
  // calls on clients that don't need it.
  if ((await loadToken(slug)) != null) {
    return { tokenPath: "(already saved — no re-extraction)" };
  }
  const entry = resolveClient(slug);
  if (!entry) throw new Error("unknown client");
  const project = await lookupProjectById(entry.projectId);
  if (!project) throw new Error("project not found in DB");
  if (!project.url) throw new Error("project has no url to scrape");

  const { runExtractTokenCli } = await import("./extractToken.js");
  const p = (async () => {
    try {
      const r = await runExtractTokenCli({
        slug,
        url: project.url ?? "",
        projectId: project.id,
      });
      EXTRACT_ERRORS.delete(slug);
      return r;
    } catch (err) {
      const msg = (err as Error).message;
      recordExtractError(slug, msg);
      throw err;
    }
  })();
  EXTRACTING_TOKENS.set(slug, p);
  p.finally(() => EXTRACTING_TOKENS.delete(slug));
  return p;
}

/**
 * POST /workspace/:slug/token/extract
 *
 * Two callers:
 *   • The home page kicks this off (fire-and-forget) the moment the
 *     page-type modal opens, so by the time the operator reaches the
 *     workspace it's usually done.
 *   • The workspace page calls it directly if no in-flight extraction
 *     exists yet (operator landed via deep-link, etc.).
 *
 * Concurrent calls for the same slug coalesce — only ONE Firecrawl +
 * Portkey pass runs at a time. The handler completes either when the
 * extraction is finished or when it errors.
 */
async function extractTokenHandler(res: ServerResponse, slug: string) {
  try {
    const r = await ensureExtractionInFlight(slug);
    sendJson(res, 200, { ok: true, token_path: r.tokenPath });
  } catch (err) {
    const msg = (err as Error).message;
    process.stderr.write(`extractToken: failed for slug=${slug}: ${msg}\n`);
    sendJson(res, 500, { error: msg });
  }
}

/**
 * GET /workspace/:slug/token/status — non-blocking probe. Tells the
 * UI whether the token is on disk, whether an extraction is in
 * flight, and (if a recent one failed) why.
 */
async function tokenStatusHandler(res: ServerResponse, slug: string) {
  const entry = resolveClient(slug);
  if (!entry) return sendJson(res, 400, { error: "unknown client" });
  const has = (await loadToken(slug)) != null;
  const inFlight = EXTRACTING_TOKENS.has(slug);
  const recentError = consumeRecentExtractError(slug);
  sendJson(res, 200, {
    has_token: has,
    extracting: inFlight,
    last_error: !has && recentError ? recentError : null,
  });
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
  /** Either a single page_type ("blog"/"service"/"category") or a
   *  comma-separated list. The CLI now accepts the CSV form too. */
  pageType?: string;
  provider?: string;
  promptOverrideFile?: string;
  /** Path to a UTF-8 file with one-off operator instructions for this
   *  regen only — merged into the top-priority directives block at
   *  generation time. Never mutates the saved graphic_token. */
  extraInstructionsFile?: string;
  /** Replicate prediction id from a prior attempt. The CLI's
   *  --resume-prediction-id flag polls this id first and uses its
   *  URL if it has succeeded since — recovers predictions that
   *  completed after a previous timeout. */
  resumePredictionId?: string;
  /** Path to a JSON file with per-run system+user template
   *  overrides keyed by prompt group ("cover" | "infographic" |
   *  "page" | "generic"). Forwarded to the CLI's
   *  --prompt-overrides-file flag. */
  promptOverridesFile?: string;
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
  if (opts.promptOverrideFile) args.push("--prompt-override-file", opts.promptOverrideFile);
  if (opts.extraInstructionsFile) args.push("--extra-instructions-file", opts.extraInstructionsFile);
  if (opts.resumePredictionId) args.push("--resume-prediction-id", opts.resumePredictionId);
  if (opts.promptOverridesFile) args.push("--prompt-overrides-file", opts.promptOverridesFile);

  const proc = spawn("npx", args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: process.env });

  const state: RunState = {
    id, client: opts.client, args, startedAt: new Date().toISOString(),
    log: [], done: false, exitCode: null, proc, listeners: new Set(),
    mode: "regen",
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
  // page_type accepts either a single value or a comma-separated list
  // (the workspace sends the full selected set so multi-page-type
  // regens work in one subprocess).
  const ptRaw = (body.get("page_type") ?? "").trim();
  const validTypes = new Set(["blog", "service", "category"]);
  const ptList = ptRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => validTypes.has(s));
  const pageTypeArg = ptList.length > 0 ? ptList.join(",") : "blog";

  // prompt_overrides arrives as a JSON-encoded string from the
  // workspace's "Are you sure you want to generate?" modal. Shape:
  //   { "<group>": { "system"?: string, "user"?: string }, … }
  // where <group> ∈ "cover" | "infographic" | "page" | "generic".
  // We validate, then drop to disk as a temp file for the CLI to
  // re-read (matching how prompt-override-file / extra-instructions-
  // file already work — keeps multi-line text away from argv).
  let promptOverridesFile: string | undefined;
  const overridesRaw = (body.get("prompt_overrides") ?? "").trim();
  if (overridesRaw.length > 0) {
    try {
      const parsed = JSON.parse(overridesRaw) as Record<string, unknown>;
      // Whitelist groups; ignore anything else so a poisoned payload
      // can't reach the CLI.
      const allowed = new Set(["cover", "infographic", "page", "generic"]);
      const cleaned: Record<string, { system?: string; user?: string }> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (!allowed.has(k) || !v || typeof v !== "object") continue;
        const inner = v as Record<string, unknown>;
        const entry: { system?: string; user?: string } = {};
        if (typeof inner.system === "string" && inner.system.trim().length > 0) entry.system = inner.system;
        if (typeof inner.user   === "string" && inner.user.trim().length   > 0) entry.user   = inner.user;
        if (Object.keys(entry).length > 0) cleaned[k] = entry;
      }
      if (Object.keys(cleaned).length > 0) {
        const tmpDir = runOutDir();
        await fs.mkdir(tmpDir, { recursive: true });
        promptOverridesFile = path.join(tmpDir, `prompt-overrides-${Date.now()}.json`);
        await fs.writeFile(promptOverridesFile, JSON.stringify(cleaned), "utf8");
      }
    } catch (err) {
      process.stderr.write(
        `regenPostHandler: ignoring malformed prompt_overrides: ${(err as Error).message}\n`,
      );
    }
  }

  const state = startRegen({
    client,
    clusterIds,
    imageIds,
    dryRun: body.get("dry_run") === "on",
    mock: body.get("mock") === "on",
    useSavedToken: body.get("use_saved_token") === "on",
    assetTypes: body.get("asset_types") || undefined,
    pageType: pageTypeArg,
    provider: body.get("provider") || undefined,
    promptOverridesFile,
  });
  // Stamp the operator's email (from their bearer JWT) so the
  // recent-runs table can show "Run by" without holding any server
  // session state. Best-effort — runs without a token still proceed.
  void writeRunMeta(state.id, {
    started_by_email: readOperatorEmail(req),
    started_by_set_at: new Date().toISOString(),
  });
  res.writeHead(303, { location: `/runs/${state.id}` });
  res.end();
}

/**
 * /flows — read-only documentation page that shows, for every asset
 * type the regen pipeline knows about, exactly which system prompt +
 * user template + aspect ratio gets used, and where each prompt is
 * sourced. Useful for operators reviewing what's actually being sent
 * to Replicate per image. Opens in a new tab from the header nav.
 */
async function flowsPage(res: ServerResponse) {
  // Lazy-import so we don't pay the ~30 KB prompt-string load on
  // every request that doesn't need it.
  const [
    { GENERATE_INFOGRAPHIC_SYSTEM_PROMPT_NEW, GENERATE_INFOGRAPHIC_USER_TEMPLATE_NEW },
    { BLOG_COVER_SYSTEM_PROMPT_NEW, BLOG_COVER_USER_TEMPLATE_NEW },
    { INTERNAL_SYSTEM_PROMPT, INTERNAL_USER_TEMPLATE },
    { EXTRACT_GRAPHIC_TOKEN_SYSTEM_PROMPT, EXTRACT_GRAPHIC_TOKEN_USER_TEMPLATE },
  ] = await Promise.all([
    import("./prompts/infographic.js"),
    import("./prompts/cover.js"),
    import("./prompts/internal.js"),
    import("./prompts/extract.js"),
  ]);

  interface FlowEntry {
    asset: string;
    page_type: string;
    aspect: string;
    source: string;
    notes: string;
    system: string;
    user: string;
  }
  const flows: FlowEntry[] = [
    {
      asset: "cover",
      page_type: "blog",
      aspect: "16:9",
      source: "synthesised from cluster.topic; OR 1st MDX <Image> for Sentinel-style",
      notes: "Same prompt as thumbnail (the Blog v2 cover_thumbnail flow drives both renders).",
      system: BLOG_COVER_SYSTEM_PROMPT_NEW,
      user: BLOG_COVER_USER_TEMPLATE_NEW,
    },
    {
      asset: "thumbnail",
      page_type: "blog",
      aspect: "3:2",
      source: "synthesised from cluster.topic; preview from page_info.thumbnail",
      notes: "Used in feeds + related-blogs widgets. Same prompt as cover, different aspect.",
      system: BLOG_COVER_SYSTEM_PROMPT_NEW,
      user: BLOG_COVER_USER_TEMPLATE_NEW,
    },
    {
      asset: "infographic",
      page_type: "blog",
      aspect: "16:9",
      source: "<image_requirement type=\"infographic\"> in S3 markdown",
      notes: "Each tag's id is the canonical image_id; description comes from the inner text.",
      system: GENERATE_INFOGRAPHIC_SYSTEM_PROMPT_NEW,
      user: GENERATE_INFOGRAPHIC_USER_TEMPLATE_NEW,
    },
    {
      asset: "internal · external · generic",
      page_type: "blog",
      aspect: "image's context (default 16:9)",
      source: "<image_requirement type=\"internal|external|generic\"> in S3 markdown",
      notes: "All three asset types route to the generic page-image prompt. Aspect honours the tag's context attr.",
      system: INTERNAL_SYSTEM_PROMPT,
      user: INTERNAL_USER_TEMPLATE,
    },
    {
      asset: "service_h1",
      page_type: "service",
      aspect: "1:1",
      source: "page_info.images[0]",
      notes: "Header image of a service page. Description comes from the image object.",
      system: INTERNAL_SYSTEM_PROMPT,
      user: INTERNAL_USER_TEMPLATE,
    },
    {
      asset: "service_body",
      page_type: "service",
      aspect: "1:1",
      source: "page_info.fold_data.service_steps.images[0]",
      notes: "Mid-page body image. Skipped for clients whose service pages don't carry the service_steps fold.",
      system: INTERNAL_SYSTEM_PROMPT,
      user: INTERNAL_USER_TEMPLATE,
    },
    {
      asset: "category_industry",
      page_type: "category",
      aspect: "1:1 (overridable per item.context)",
      source: "page_info.fold_data.industries.items[*].image",
      notes: "One record per item in the industries-served list.",
      system: INTERNAL_SYSTEM_PROMPT,
      user: INTERNAL_USER_TEMPLATE,
    },
    {
      asset: "(extract_graphic_token)",
      page_type: "—",
      aspect: "—",
      source: "Firecrawl scrape (markdown + branding) → Claude Sonnet 4.6 via Portkey",
      notes: "Run once per client (or auto-extracted on first regen). Stores graphic-tokens/<slug>.json.",
      system: EXTRACT_GRAPHIC_TOKEN_SYSTEM_PROMPT,
      user: EXTRACT_GRAPHIC_TOKEN_USER_TEMPLATE,
    },
  ];

  const sections = flows.map((f, i) => `
<section class="card flow-card" id="flow-${i}">
  <header class="flow-head">
    <div>
      <h2 style="margin:0;font-size:16px">
        <span class="pill ${esc((f.asset.split(" ")[0] ?? "").trim())}">${esc(f.asset)}</span>
        <span style="color:var(--ink-muted);font-weight:400;font-size:13px;margin-left:8px">${esc(f.page_type)}${f.aspect !== "—" ? " · " + esc(f.aspect) : ""}</span>
      </h2>
    </div>
  </header>
  <div class="flow-meta">
    <div class="info-grid">
      <div class="k">source</div>      <div class="v"><code>${esc(f.source)}</code></div>
      <div class="k">aspect ratio</div><div class="v"><code>${esc(f.aspect)}</code></div>
      <div class="k">prompt routing</div><div class="v">system + user templates below</div>
    </div>
    <div class="sub" style="margin-top:8px">${esc(f.notes)}</div>
  </div>
  <details style="margin-top:12px">
    <summary><strong style="font-size:13px">System prompt</strong> <span class="sub">(${f.system.length.toLocaleString()} chars)</span></summary>
    <pre class="flow-prompt">${esc(f.system)}</pre>
  </details>
  <details style="margin-top:8px">
    <summary><strong style="font-size:13px">User template</strong> <span class="sub">(${f.user.length.toLocaleString()} chars; <code>{{placeholder}}</code> tokens get interpolated at run time)</span></summary>
    <pre class="flow-prompt">${esc(f.user)}</pre>
  </details>
</section>`).join("");

  sendHtml(res, 200, shell("Flows", `
<section class="card">
  <h1>Image flows</h1>
  <div class="sub">Per-asset-type breakdown of which system prompt, user template, and aspect ratio the regen pipeline sends to Replicate. Source files: <code>src/prompts/*.ts</code> + the routing switch in <code>src/buildPrompt.ts</code>.</div>
</section>

<section class="card">
  <h2 style="margin-bottom:8px">Routing table</h2>
  <table class="cluster-list">
    <thead><tr>
      <th>asset_type</th><th>page_type</th><th>aspect</th><th>source</th><th>system prompt</th>
    </tr></thead>
    <tbody>
      ${flows.map((f, i) => `
        <tr style="cursor:pointer" onclick="document.getElementById('flow-${i}').scrollIntoView({behavior:'smooth',block:'start'})">
          <td><span class="pill ${esc((f.asset.split(" ")[0] ?? "").trim())}">${esc(f.asset)}</span></td>
          <td>${esc(f.page_type)}</td>
          <td><code>${esc(f.aspect)}</code></td>
          <td class="sub">${esc(f.source)}</td>
          <td class="sub" style="font-size:11px">${esc(f.system.slice(0, 30))}…</td>
        </tr>`).join("")}
    </tbody>
  </table>
</section>

${sections}
`));
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

// CsvRowParsed lives in web-types.ts so apply.ts can use it without
// pulling in the rest of the web server. Re-imported below.
import type { CsvRowParsed } from "./web-types.js";

/**
 * Returns the parsed rows on success, or an error result that callers
 * can surface to the operator. The original behaviour (swallow + return
 * []) silently masked CSV-missing / CSV-malformed errors as "image_id
 * not in CSV", which made post-deploy path drift on Railway look like a
 * data bug. Callers that prefer the legacy contract (just want rows or
 * empty) can use `readRunCsvOrEmpty`.
 */
async function readRunCsv(csvPath: string): Promise<
  { rows: CsvRowParsed[] } | { error: string; code: "ENOENT" | "EPARSE" | "EOTHER" }
> {
  let raw: string;
  try {
    raw = await fs.readFile(csvPath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return { error: `CSV file missing on disk: ${csvPath}`, code: "ENOENT" };
    }
    return { error: `CSV file read failed (${e.code ?? "?"}): ${csvPath} — ${e.message}`, code: "EOTHER" };
  }
  try {
    const rows = csvParse(raw, { columns: true, skip_empty_lines: true }) as CsvRowParsed[];
    return { rows };
  } catch (err) {
    return { error: `CSV parse failed at ${csvPath}: ${(err as Error).message}`, code: "EPARSE" };
  }
}

async function readRunCsvOrEmpty(csvPath: string): Promise<CsvRowParsed[]> {
  const r = await readRunCsv(csvPath);
  return "rows" in r ? r.rows : [];
}

/**
 * Walk ./out/manifest-*.json looking for the run-id stamp the CLI wrote
 * during regen. If found, build a synthetic RunState the run-page handler
 * can render from. log + listeners are empty (the live process is gone);
 * csvPath / htmlPath / done / exitCode come from the manifest.
 */
/**
 * Resolve a path field stored in a manifest. Old manifests baked
 * absolute paths into csv/html (e.g. /app/out/foo.csv when cwd was
 * /app, before RUN_OUT_DIR landed). After a redeploy that flipped the
 * runs directory to a Railway Volume at /data/runs, those absolute
 * paths no longer exist — but the files themselves WERE migrated /
 * still live alongside their manifest. We rescue them by also trying
 * the basename against the current runOutDir().
 *
 * Order: (1) the stored absolute path — works when nothing moved;
 * (2) basename joined to runOutDir() — works after a volume remount.
 * Returns the first path that exists on disk, or null if both miss.
 */
async function rehydrateManifestPath(stored: unknown): Promise<string | null> {
  if (typeof stored !== "string" || !stored) return null;
  try {
    await fs.access(stored);
    return stored;
  } catch { /* fall through */ }
  const basename = path.basename(stored);
  const candidate = path.join(runOutDir(), basename);
  try {
    await fs.access(candidate);
    return candidate;
  } catch { /* fall through */ }
  return null;
}

async function tryReconstructRunFromDisk(id: string): Promise<RunState | null> {
  const dir = runOutDir();
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
      // Match — synthesise. Rehydrate csv/html paths so old manifests
      // whose absolute paths point at a previous cwd / volume mount
      // still resolve to the actual file on the current filesystem.
      const csvPath = await rehydrateManifestPath(j.csv);
      const htmlPath = await rehydrateManifestPath(j.html);
      const state: RunState = {
        id,
        client: typeof j.client === "string" ? j.client : "",
        args: ["(persisted run)"],
        startedAt: typeof j.started_at === "string" ? j.started_at : "",
        log: ["(log not available — server was restarted after this run finished)\n"],
        done: true,
        exitCode: 0,
        csvPath: csvPath ?? undefined,
        htmlPath: htmlPath ?? undefined,
        proc: { kill() { /* no-op */ } } as unknown as ChildProcess,
        listeners: new Set(),
        mode: j.mode === "upload" ? "upload" : "regen",
      };
      RUNS.set(id, state);
      return state;
    } catch {
      /* skip corrupt manifest */
    }
  }
  return null;
}

async function runPage(res: ServerResponse, id: string, requestedStage: "prepare" | "apply" = "apply") {
  let state = RUNS.get(id);
  if (!state) {
    // Manifest fallback: a previous server process spawned this run; the
    // in-memory state is gone but the artefacts are still on disk.
    // Reconstruct a "completed" RunState from the manifest so the publish
    // view still renders. The log + live SSE features won't work here —
    // the operator gets the persisted CSV + cluster grid only.
    const reconstructed = await tryReconstructRunFromDisk(id);
    if (!reconstructed) {
      // No manifest for this id — most likely the retention sweep
      // pruned it. Tell the operator what happened instead of a bare
      // 404 so they know it's expected behaviour, not a bug.
      const cfg = loadRetentionConfig();
      sendHtml(
        res,
        404,
        shell(
          "Run expired",
          `<section class="card">
             <h1>Run <code>${esc(id)}</code> not found</h1>
             <div class="sub" style="margin-top:8px">
               Either the id is wrong, or the run's downloads have expired and the artefacts were pruned.
               Retention on this deployment is <strong>${cfg.maxRunsKept} runs</strong> or
               <strong>${cfg.retentionHours} hours</strong>, whichever trips first.
             </div>
             <div style="margin-top:14px"><a class="btn" href="/runs">← back to runs</a></div>
           </section>`,
        ),
      );
      return;
    }
    state = reconstructed;
  }
  // Prepare stage only makes sense for upload-mode runs. If a regen
  // run is hit with ?stage=prepare we silently fall back to apply so
  // the page renders as normal — otherwise the action bar would
  // mismatch the card content (cards show generated images but the
  // bottom bar would say "Step 1 — files uploaded").
  const stage: "prepare" | "apply" = requestedStage === "prepare" && state.mode === "upload" ? "prepare" : "apply";
  const initial = esc(state.log.join(""));
  const cmd = esc(`npx ${state.args.join(" ")}`);

  // If the run is done and a CSV exists, build the publish view —
  // workspace-mirrored: one cluster card per affected cluster, with
  // a click-anywhere row that opens a drawer of new-image cards
  // (per-image Apply + Regenerate). Bulk "Apply all pending" lives
  // in the sticky publish action bar at the bottom of the page.
  let resultsHtml = "";
  if (state.done && state.csvPath) {
    const rows = await readRunCsvOrEmpty(state.csvPath);
    if (rows.length > 0) {
      const grouped = new Map<string, { topic: string; rows: CsvRowParsed[] }>();
      for (const r of rows) {
        const g = grouped.get(r.cluster_id) ?? { topic: r.page_topic, rows: [] };
        g.rows.push(r);
        grouped.set(r.cluster_id, g);
      }
      const totalCompleted = rows.filter((r) => r.status === "completed").length;
      const totalFailed = rows.filter((r) => r.status === "failed").length;

      // Enrich the publish view with three pieces of DB data, in
      // parallel: project URL (for the per-cluster "View current
      // page" link), cluster slug + page_type (URL pattern is
      // <project_url>/feeds/<page_type>/<slug>), and the existing
      // CDN URLs (so each card can show old-vs-new compare).
      const projectId = rows[0]?.project_id ?? "";
      const clusterIds = [...grouped.keys()];
      // Index the CSV-recorded previous_image_url first; fall back to
      // a media_registry batch lookup only for image_ids that don't
      // have one (older CSVs written before the column existed).
      const csvOldUrls = new Map<string, string>();
      for (const r of rows) {
        if (r.previous_image_url && r.previous_image_url.trim().length > 0) {
          csvOldUrls.set(r.image_id, r.previous_image_url);
        }
      }
      const realImageIds = rows
        .map((r) => r.image_id)
        .filter((id) => !id.includes("/") && !csvOldUrls.has(id));
      const [projectForRun, clusterMeta, oldUrlsMap] = await Promise.all([
        projectId ? lookupProjectById(projectId).catch(() => null) : Promise.resolve(null),
        lookupClusterSlugs(clusterIds).catch(() => new Map()),
        realImageIds.length > 0 ? lookupImageUrls(realImageIds).catch(() => new Map()) : Promise.resolve(new Map()),
      ]);
      const publishedUrlOf = (clusterId: string): string | null => {
        const m = clusterMeta.get(clusterId);
        if (!m || !m.slug || !projectForRun) return null;
        return buildPublishedUrl(projectForRun, m.page_type, m.slug);
      };
      const oldUrlOf = (imageId: string): string | null => {
        // Primary source: the CSV column we now write at run start.
        const fromCsv = csvOldUrls.get(imageId);
        if (fromCsv) return fromCsv;
        // Fallback for older runs: live media_registry lookup.
        const u = oldUrlsMap.get(imageId);
        if (!u) return null;
        return u["1080"] ?? u["720"] ?? u["360"] ?? null;
      };

      // Inline cluster sections. Each card has just two controls:
      // Apply (S3 PutObject) and Regenerate (re-runs that single
      // image through the pipeline).
      const clusterSections = [...grouped.entries()].map(([clusterId, g]) => {
        const cards = g.rows
          .map((r) => {
            const oldUrl = oldUrlOf(r.image_id);
            // Upload-mode rows start with status="pending" and stay that
            // way until the operator drops a file (then "ready"). The
            // generic "no image_url_new yet → failed" heuristic would
            // mis-flag every still-awaiting-upload slot as a Replicate
            // failure, even though no Replicate call ever happened.
            // Treat upload-mode pending/ready rows as "not failed";
            // explicit r.status === "failed" still fires.
            const isUploadModeRow = state.mode === "upload";
            const isFailed = isUploadModeRow
              ? r.status === "failed"
              : r.status === "failed" || (!r.image_url_new && r.status !== "completed");
            // Image preview is rendered without an inline onclick; a
            // delegated click handler on the page binds zoom to every
            // image on load (more reliable across browsers + matches
            // future cards added dynamically). For failed/no-image
            // rows we render an unmistakable failure placeholder
            // instead of a bare status string.
            // Preview is served through /runs/<id>/preview/<image_id>
            // — our own endpoint that streams the local file first
            // and only falls back to the (1-hour-TTL) Replicate URL
            // when local is missing. Wiring it through our endpoint
            // means shared run URLs keep rendering long after the
            // Replicate signed URL expires.
            //
            // Upload-mode runs swap the preview for a drop zone when
            // no file has been uploaded yet. Once an upload lands
            // (image_local_path populated), we render the same
            // /preview/ image, plus a Replace overlay so the
            // operator can swap the dropped file before applying.
            const isUpload = state.mode === "upload";
            const hasUploadedFile = isUpload && !!r.image_local_path;
            const previewHtml = isUpload
              ? (hasUploadedFile
                ? `<img class="rc-preview-img" src="/runs/${esc(id)}/preview/${encodeURIComponent(r.image_id)}?t=${encodeURIComponent(Date.now().toString())}" alt="" loading="lazy">`
                : `<div class="rc-dropzone" data-dropzone data-image-id="${esc(r.image_id)}"
                       onclick="dzClick(event)"
                       ondragenter="dzDragEnter(event)"
                       ondragover="dzDragOver(event)"
                       ondragleave="dzDragLeave(event)"
                       ondrop="dzDrop(event)">
                    <div class="dz-icon">↑</div>
                    <div class="dz-text">Drop file here</div>
                    <div class="dz-sub">or click to browse — png · jpeg · webp · ≤10MB</div>
                   </div>`)
              : (r.image_url_new || r.image_local_path)
                ? `<img class="rc-preview-img" src="/runs/${esc(id)}/preview/${encodeURIComponent(r.image_id)}" alt="" loading="lazy">`
                : isFailed
                  ? `<div class="ph ph-failed"><span class="ph-failed-icon">⚠</span><span>Generation failed</span><span class="ph-failed-hint">Hit ↻ Regenerate to retry</span></div>`
                  : `<div class="ph">${esc(r.status)}</div>`;
            // Always show SOMETHING in red when a row is failed, even
            // if the upstream error string is empty — operators were
            // seeing blank cards with no explanation when the CSV
            // happened to land without an error column populated.
            const errText = (r.error || "").trim()
              || (isFailed
                ? "No specific error captured — likely a Replicate empty output or model refusal. Hit ↻ Regenerate to retry (it will try to recover any prediction that completed late)."
                : "");
            const errCell = errText
              ? `<div class="err-line"><strong>Error:</strong> ${esc(errText.slice(0, 400))}</div>`
              : "";
            const synthetic = r.image_id.includes("/");
            // Compare button gate: BOTH a new image AND a known old
            // image. With the previous_image_url CSV column populated
            // at run-start, every workspace-visible image carries its
            // CDN URL through to here, so this is true for every card
            // on any run created after that change shipped.
            // Upload-mode rows don't carry image_url_new, so the
            // "fresh image exists" half of the gate is image_local_path
            // (set on first drop). Compare still needs an oldUrl from
            // the live page_info to show what we're replacing.
            const canCompare = !!oldUrl && (!!r.image_url_new || (isUpload && !!r.image_local_path));
            // The upload→repoint pipeline DOES handle cover &
            // thumbnail (cover = 1st <Image> UUID; thumbnail = the
            // live page_info.thumbnail URL string). Only truly
            // synthetic non-cover/thumbnail ids (e.g. blog-images/<id>
            // placeholders) have no resolvable reference site.
            const applyUnsupported =
              synthetic && r.asset_type !== "cover" && r.asset_type !== "thumbnail";
            const applyDisabledReason = applyUnsupported
              ? "No resolvable page_info reference for this synthetic id — regenerate from a real cluster image"
              : "";
            return `
<div class="result-card${isUpload ? ' upload-mode' : ''}" data-image-id="${esc(r.image_id)}" data-cluster-id="${esc(clusterId)}" data-state="${isFailed ? "failed" : "pending"}"${isUpload ? ' data-upload="1"' : ''}${isUpload && !hasUploadedFile ? ' data-needs-file="1"' : ''}${applyUnsupported ? ' data-apply-unsupported="1"' : ""}${synthetic ? ' data-synthetic="1"' : ""}${oldUrl ? ` data-old-url="${esc(oldUrl)}"` : ""}>
  <label class="rc-pick" title="${applyUnsupported ? esc(applyDisabledReason) : "Include in bulk actions (Apply / Regenerate)"}">
    <input type="checkbox" class="rc-pick-cb" ${applyUnsupported || isFailed ? "disabled" : "checked"} onchange="onCardPick(this)">
  </label>
  <div class="rc-img">${previewHtml}
    ${isFailed ? "" : `<button class="rc-zoom" type="button" data-zoom title="Zoom in"><span aria-hidden="true">⤢</span></button>`}
  </div>
  <div class="rc-body">
    <div class="rc-row">
      <span class="pill ${esc(r.asset_type)}">${esc(r.asset_type)} · ${esc(r.aspect_ratio)}</span>
      ${isFailed ? `<span class="state-pill state-failed">failed</span>` : `<span class="state-pill"></span>`}
    </div>
    <div class="rc-id"><code>${esc(r.image_id)}</code></div>
    <div class="rc-desc">${esc((r.description_used || "").slice(0, 220))}</div>
    ${errCell}
    <div class="rc-status-line"></div>
    <div class="rc-actions">
      ${isUpload
        ? `<button class="btn-replace" type="button" data-replace ${hasUploadedFile ? '' : 'style="display:none"'} title="Re-drop a different file for this slot">↻ Replace</button>
           <button class="btn-clear" type="button" data-clear ${hasUploadedFile ? '' : 'style="display:none"'} title="Remove the uploaded file for this slot">✕ Clear</button>`
        : `<button class="btn-regen" type="button" data-regen title="Regenerate this image">↻ Regenerate</button>
           <a class="btn-regen-custom" type="button" data-regen-custom title="Re-roll with one-off instructions for this image only" role="button" tabindex="0">↻ Custom…</a>`}
      ${oldUrl
        ? `<button class="btn-compare" type="button" data-compare ${isUpload && !hasUploadedFile ? 'style="display:none"' : ""} title="Old (live) vs new (this run), side-by-side">⇄ Compare</button>`
        : ""}
      ${r.image_url_new || r.image_local_path
        ? `<a class="btn btn-download" href="/runs/${esc(id)}/download/${encodeURIComponent(r.image_id)}" title="Download this image (no recompression)" download>⬇ Download</a>`
        : ""}
      ${stage === "prepare" ? "" : `<span class="apply-tip"${applyUnsupported ? ` data-tip="${esc(applyDisabledReason)}"` : (isUpload && !hasUploadedFile) ? ' data-tip="Drop a replacement file first."' : ""}>
        <button class="btn-apply primary" type="button" data-apply ${(applyUnsupported || (isUpload && !hasUploadedFile)) ? `disabled aria-disabled="true"` : `title="Upload this image via the Gushwork media API, then repoint page_info to the new id. Dry-run still uploads (preview only, no page_info PUT)."`}>Upload + Repoint</button>
      </span>`}
    </div>
  </div>
</div>`;
          })
          .join("");
        const publishedUrl = publishedUrlOf(clusterId);
        return `
<section class="card cluster-section" id="cluster-${esc(clusterId)}" data-cluster-id="${esc(clusterId)}">
  <header class="cs-head">
    <label class="cs-pick" title="Select / deselect every image in this cluster">
      <input type="checkbox" class="cs-pick-cb" checked onchange="onClusterPick(this, '${esc(clusterId)}')">
    </label>
    <div style="flex:1">
      <div style="font-weight:600;font-size:14px">${esc(g.topic || "(no topic)")}</div>
      <div class="sub"><code>${esc(clusterId)}</code> · ${g.rows.length} new images</div>
    </div>
    <div class="cs-actions">
      ${publishedUrl ? `<a class="btn btn-published" href="${esc(publishedUrl)}" target="_blank" rel="noopener" title="Open the live page in a new tab">View current page →</a>` : ""}
      <button onclick="applyCluster('${esc(clusterId)}')">Upload + Repoint this cluster</button>
      <button onclick="revertCluster('${esc(clusterId)}')" title="Restore this cluster's page_info from the latest repoint backup. Dry-run previews; current state is snapshotted first.">↩ Revert this cluster</button>
    </div>
  </header>
  <div class="result-grid">${cards}</div>
</section>`;
      }).join("");

      resultsHtml = `
<section class="card" id="results-summary">
  <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
    <label class="all-pick" title="Select / deselect everything">
      <input type="checkbox" id="all-pick-cb" checked onchange="onAllPick(this)">
      <span>All</span>
    </label>
    <h2 style="margin:0">${stage === "prepare" ? "Step 1 · Drop replacement images" : "Publish — verify and push to S3"}</h2>
    <span class="sub">${rows.length} ${stage === "prepare" ? "slots awaiting files" : "new images"} across ${grouped.size} clusters${stage === "prepare" ? "" : ` · <strong style="color:var(--ok)">${totalCompleted} ready</strong>${totalFailed ? ` · <strong style="color:var(--err)">${totalFailed} failed</strong>` : ""}`}</span>
    <span class="sub" id="picked-count" style="margin-left:auto"></span>
  </div>
  <div class="sub" style="margin-top:6px">${stage === "prepare"
    ? `Drag-and-drop a replacement file (<strong>PNG · JPEG · WebP · ≤10MB</strong>) into each slot you want to push live. You can skip slots — they stay untouched in the live page. When you're done, click <strong>Continue to Apply</strong> to upload the new images and repoint <code>page_info</code>.`
    : `Click <strong>⤢</strong> on any card to zoom, or <strong>⇄ Compare</strong> for an old-vs-new side-by-side. Use the checkboxes to scope <strong>Apply selected</strong> / <strong>Regenerate selected</strong> — pick by image, by cluster, or all at once.`}</div>
</section>

${clusterSections}

<!-- Compare modal — old (live) vs new (this run). Cross icon closes. -->
<div class="cmp-overlay" id="cmp-overlay" onclick="closeCompareOnBackdrop(event)">
  <div class="cmp-modal" role="dialog" aria-modal="true">
    <header class="cmp-head">
      <strong id="cmp-title">Compare</strong>
      <span class="sub" id="cmp-meta"></span>
      <button class="cmp-x" onclick="closeCompare()" aria-label="Close">×</button>
    </header>
    <div class="cmp-body">
      <div class="cmp-pane">
        <div class="cmp-pane-h">Current (live)</div>
        <img id="cmp-old" alt="">
        <div id="cmp-old-ph" class="cmp-ph" style="display:none">
          <div class="sub">Loading current image…</div>
        </div>
      </div>
      <div class="cmp-pane">
        <div class="cmp-pane-h cmp-pane-h-new">New</div>
        <img id="cmp-new" alt="">
        <div id="cmp-new-ph" class="cmp-ph" style="display:none">
          <div class="sub">New image bytes no longer available.</div>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- Regenerate (custom instructions) modal — operator-supplied
     one-off addendum for a single regeneration. Cancel discards, the
     primary button kicks off /api/regen-one with the text in the body. -->
<div class="cmp-overlay" id="rc-overlay" onclick="rcBackdrop(event)">
  <div class="cmp-modal" role="dialog" aria-modal="true" style="max-width:640px">
    <header class="cmp-head">
      <strong>Regenerate with custom instructions</strong>
      <span class="sub" id="rc-meta" style="margin-left:auto"></span>
    </header>
    <div style="padding:18px 20px">
      <label style="font-size:12px;color:var(--ink-muted);display:block;margin-bottom:6px">
        These instructions are appended to the image-generation prompt
        as a top-priority block — they override visual choices Claude
        would otherwise make. Saved brand guidelines still apply;
        these stack on top for this regen only.
      </label>
      <textarea id="rc-text" placeholder="e.g. make it warmer / remove the people / use a closer crop / lean editorial, not stock"
        style="width:100%;min-height:140px;font-size:13px;line-height:1.45"></textarea>
    </div>
    <footer style="padding:12px 18px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end">
      <button type="button" onclick="rcClose()">Cancel</button>
      <button type="button" class="primary" id="rc-submit" onclick="rcSubmit()">↻ Regenerate</button>
    </footer>
  </div>
</div>

<!-- Sticky bottom action bar — variant per stage:
       prepare (upload-mode onboarding): progress chip + "Continue to Apply"
       apply   (default): full Apply / Regen / Token / Revert toolbox -->
${stage === "prepare" ? `
<div class="action-bar">
  <div class="stats">
    Step 1 of 2 — <strong id="dz-uploaded-count">0</strong> of <strong>${rows.length}</strong> files uploaded
  </div>
  <div class="right">
    <button class="primary" id="prepare-continue-btn" disabled onclick="goToApplyStage()" title="Continue to the Apply step. Enabled once at least one slot has a dropped file.">Continue to Apply</button>
  </div>
</div>` : `
<div class="action-bar">
  <div class="stats">
    <strong id="applied-count">0</strong> applied · <strong id="failed-count">0</strong> failed · <strong id="pending-count">0</strong> pending · <strong id="picked-count-bar">0</strong> selected
  </div>
  <div class="right">
    <a class="btn" id="download-all-btn" href="/runs/${esc(id)}/download.zip" title="Stream a ZIP of every generated image, organised by cluster topic. Images are not re-encoded." download>⬇ Download all (ZIP)</a>
    <span id="tok-chip" title="Bearer token used for upload + repoint. Pasted here, held in server memory until it expires (~1h) or the process restarts." style="font:12px/1 ui-sans-serif,system-ui;padding:6px 10px;border:1px solid var(--border);border-radius:6px;color:#a33;">🔑 no token</span>
    <button id="tok-set-btn" onclick="setToken()" title="Paste a fresh bearer token from https://platform.gushwork.ai/api/auth/token">🔑 Set token</button>
    <label style="font:12px/1 ui-sans-serif,system-ui;display:flex;align-items:center;gap:5px" title="Dry-run still UPLOADS images (new ids are needed to preview) — it only skips the page_info PUT.">
      <input type="checkbox" id="dry-toggle" checked onchange="APPLY_DRY_RUN=this.checked"> dry-run
    </label>
    ${state.mode === "upload" ? "" : `<button id="regen-all-btn" onclick="regenAllPicked()" title="Re-roll every selected image in parallel">↻ Regenerate selected</button>`}
    <button id="revert-all-btn" onclick="revertRun()" title="Restore EVERY cluster in this run from its latest repoint backup. Dry-run previews; each current state is snapshotted first.">↩ Revert run</button>
    <button class="primary" id="apply-all-btn" onclick="applyAllPicked()">Upload + Repoint selected →</button>
  </div>
</div>`}
`;
    }
  }

  const retentionCfg = loadRetentionConfig();
  const expiry = expiryForRun({ startedAt: state.startedAt, cfg: retentionCfg });
  const expiryHtml = expiry.expiresAt
    ? `<span class="retention-badge" title="Until this time the run's bytes are served from local disk on the server. Older than ~${retentionCfg.replicateUrlTtlHours}h, Replicate's signed URLs expire too, so any image whose local copy was lost would no longer be recoverable.">⏱ Downloads available until <strong>${esc(expiry.expiresAt.toISOString().slice(0, 16).replace("T", " "))} UTC</strong>${expiry.hoursLeft != null ? ` · <span class="ret-left">~${expiry.hoursLeft}h left</span>` : ""}</span>`
    : "";

  sendHtml(res, 200, shell(`run ${id}`, `
<section class="card">
  <h1>Run <code>${esc(id)}</code></h1>
  <div class="sub">client <code>${esc(state.client)}</code> · started <code>${esc(state.startedAt)}</code> · <span id="elapsed-clock">—</span></div>
  ${expiryHtml ? `<div style="margin-top:8px">${expiryHtml}</div>` : ""}
  <details style="margin-top:8px">
    <summary class="sub">command</summary>
    <pre style="background:#f1f5f9;padding:8px 12px;border-radius:6px;font-size:12px;overflow:auto"><code>${cmd}</code></pre>
  </details>
</section>

${state.done ? "" : `
<!-- In-progress hero: shown only while the subprocess is still
     running. Animated dots + cycled status messages give the operator
     something to look at during long generations (~30–60s/image). -->
<section class="card running-hero" id="running-hero">
  <div class="running-spinner-wrap"><span class="running-spinner"></span></div>
  <div class="running-text">
    <div class="running-stage" id="running-stage">Warming up…</div>
    <div class="running-tip" id="running-tip">Hang tight — generated images appear below as they finish.</div>
  </div>
  <div class="running-meta">
    <div class="running-elapsed" id="running-elapsed">0s elapsed</div>
    <div class="running-count" id="running-count"></div>
  </div>
</section>`}

<section class="card">
  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
    <h2 style="margin:0">Status</h2>
    <button class="btn" onclick="window.location.reload()" title="Reload to refresh state from disk">↻ Reload status</button>
  </div>
  <div id="status" style="margin-top:8px">
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

// ── In-progress UI: stateful stage label + cycling platform tips ──
// Re-parses the FULL log on every update (existing content on load,
// then streamed chunks) so the primary stage label always reflects
// the latest event — never stuck on "Warming up". Mirrors the
// Claude UX: a primary verb that mutates ("Thinking…", "Generating
// image 3 of 7…") with a rotating secondary tip about the platform.
const RUN_STARTED_AT = ${JSON.stringify(state.startedAt)};
// Bound at parse time via window so anything called during script
// init (updateUploadProgress, etc.) reads it without TDZ — const/let
// declarations sit in TDZ until their line executes, and a stale
// build kept tripping on it. window.* is initialised the moment
// this line is parsed, no ordering hazard.
window.RUN_STAGE = ${JSON.stringify(stage)};
let onLogStream = null;
(function () {
  const heroEl = document.getElementById('running-hero');
  const stageEl = document.getElementById('running-stage');
  const tipEl = document.getElementById('running-tip');
  const elapsedEl = document.getElementById('running-elapsed');
  const countEl = document.getElementById('running-count');
  const clockEl = document.getElementById('elapsed-clock');
  const startTs = Date.parse(RUN_STARTED_AT) || Date.now();
  const fmt = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return s + 's elapsed';
    const m = Math.floor(s / 60), r = s % 60;
    return m + 'm ' + r + 's elapsed';
  };
  function tick() {
    const ms = Date.now() - startTs;
    if (elapsedEl) elapsedEl.textContent = fmt(ms);
    if (clockEl) clockEl.textContent = fmt(ms);
  }
  tick();
  setInterval(tick, 1000);

  // Platform tips — rotated every 5s in the secondary line. Focus is
  // on things the user can do / should know about the platform, not
  // generic motivational text.
  const TIPS = [
    'You can close this tab — the run keeps going server-side.',
    'Each image runs through Claude (prompt) + Replicate (generation).',
    'Regenerate re-uses the same prompt to skip the Claude round-trip.',
    'Cards below appear as soon as their images finish.',
    'Use ⇄ Compare on any card to put old next to new before applying.',
    'Apply pushes directly to gw-content-store at the live image key.',
    'Logos + brand guidelines come from the project\\'s graphic_token.',
    'Multiple runs can stream in parallel — open more tabs if you need.',
  ];
  if (tipEl && heroEl) {
    let idx = 0;
    setInterval(() => {
      idx = (idx + 1) % TIPS.length;
      tipEl.style.opacity = '0';
      setTimeout(() => { tipEl.textContent = TIPS[idx]; tipEl.style.opacity = '1'; }, 200);
    }, 5000);
  }

  if (!heroEl) return; // run already done, hero not rendered

  // Stage parser: scans the entire raw log and returns the most recent
  // recognised state. Order matters — later in the log wins. Also
  // accumulates done/failed counts as it goes.
  function deriveState(fullText) {
    const lines = fullText.split('\\n');
    let stage = 'Warming up';
    let total = 0, done = 0, failed = 0;
    let lastImageStage = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;

      // Per-image progress: "[3/12] cluster=… asset=cover id=… status=completed"
      const m = line.match(/^\\[(\\d+)\\/(\\d+)\\]\\s+cluster=\\S+\\s+asset=(\\S+)\\s+id=\\S+\\s+(.*)$/);
      if (m) {
        const n = Number(m[1]), tot = Number(m[2]), asset = m[3], rest = m[4];
        total = tot;
        if (/status=completed|status=mock/.test(rest)) done++;
        else if (/status=failed/.test(rest)) failed++;
        lastImageStage = 'Generating image ' + n + ' of ' + tot + ' · ' + asset;
        continue;
      }

      // Setup lifecycle (each row overwrites the prior stage).
      if (/^regen: client=/.test(line))                             stage = 'Loading project info';
      else if (/^regen: brand_guidelines=loaded/.test(line))        stage = 'Reading brand guidelines';
      else if (/^regen: logo_url=overridden/.test(line))            stage = 'Applying logo override';
      else if (/^regen: mock mode/.test(line))                      stage = 'Mock mode — skipping APIs';
      else if (/^regen: graphic_token=fresh|extracting/i.test(line))stage = 'Extracting graphic_token from the live site';
      else if (/^regen: graphic_token=saved/.test(line))            stage = 'Saved graphic_token';
      else if (/^regen: graphic_token=loaded/.test(line))           stage = 'Loaded saved graphic_token';
      else if (/^regen: \\d+ published .* clusters/.test(line))     stage = 'Listing published pages';
      else if (/^regen: \\d+ image records to process/.test(line))  stage = 'Resolving image records';
      else if (/^regen: writing /.test(line))                       stage = 'Preparing output files';
      else if (/^regen: nothing to do/.test(line))                  stage = 'Nothing to do — exiting';
      else if (/^regen: csv=/.test(line))                           stage = 'Wrote CSV report';
      else if (/^regen: html=/.test(line))                          stage = 'Wrote HTML report';
      else if (/^regen failed:/.test(line))                         stage = 'Run failed';
      else if (/^extract-token: scraping/.test(line))               stage = 'Scraping the live site (Firecrawl)';
      else if (/^extract-token: calling portkey/.test(line))        stage = 'Asking Claude for the brand token';
    }
    // Once images start generating, the per-image stage outranks the
    // setup stages until the run finishes.
    if (lastImageStage && done < total) stage = lastImageStage;
    return { stage, total, done, failed };
  }

  function applyState(s) {
    stageEl.textContent = s.stage;
    if (countEl) {
      if (s.total > 0) {
        const parts = [s.done + ' / ' + s.total + ' done'];
        if (s.failed > 0) parts.push(s.failed + ' failed');
        countEl.textContent = parts.join(' · ');
      } else {
        countEl.textContent = '';
      }
    }
  }

  // Initial parse: everything already on the page (server-side log
  // for any run that started before this tab loaded).
  const logEl = document.getElementById('log');
  if (logEl) applyState(deriveState(logEl.textContent || ''));

  onLogStream = (_chunkText) => {
    // The raw <pre> already gets the chunk appended before this fires,
    // so re-parsing its full textContent picks up the new event AND
    // every previous one in order — simplest, always-correct path.
    if (logEl) applyState(deriveState(logEl.textContent || ''));
  };
})();

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
    else { applyBtn.textContent = 'Upload + Repoint'; applyBtn.disabled = card.dataset.applyUnsupported === '1'; }
  }
  const errLine = card.querySelector('.rc-status-line');
  if (errLine) {
    errLine.textContent = (s === 'failed' && opts && opts.error) ? opts.error : '';
    errLine.style.display = (s === 'failed' && opts && opts.error) ? 'block' : 'none';
  }
}

// Per-card "Apply to S3" runs in DRY-RUN mode until AWS write
// credentials are provisioned: we open a modal that walks through
// every step (DB lookup, source bytes, resize sizes, derived S3 keys,
// would-PUT targets) so the operator can verify the plan before any
// real write goes out. When write creds land, flip DRY_RUN to false
// here and the same trace will be shown after the actual PUT.
let APPLY_DRY_RUN = true;

// Run-level mutex. Only ONE apply op (single/cluster/run/picked) can
// be in flight at a time — protects against double-clicks and against
// two concurrent operators colliding on the same run. Tracks via a
// body data attribute so CSS can dim every Apply control at once.
let APPLY_BUSY = false;
function setApplyBusy(busy) {
  APPLY_BUSY = busy;
  document.body.setAttribute('data-apply-busy', busy ? '1' : '0');
}
function applyBusyGuard() {
  if (APPLY_BUSY) {
    alert('An apply is already in progress for this run. Wait for it to finish before starting another.');
    return true;
  }
  return false;
}

// Bearer-token panel. PER-TAB, NOT SERVER-GLOBAL.
//
// History: tokens used to live in a process-global API_TOKEN, which
// leaked between concurrent operators — whoever set a token last
// became "the operator" for every other tab pointing at the same
// Railway instance. The cure is to keep the token in the operator's
// own browser (sessionStorage, scoped to this tab only) and send it
// as Authorization: Bearer <jwt> on every request that needs it.
// The server reads from the header per-request and never stores.
const TOKEN_KEY = 'gw_repoint_bearer_v1';
function getStoredToken() {
  try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}
function setStoredToken(tok) {
  try { sessionStorage.setItem(TOKEN_KEY, tok); } catch { /* */ }
}
function clearStoredToken() {
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* */ }
}
function decodeTokenPayload(tok) {
  try {
    const part = (tok || '').split('.')[1] || '';
    return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
  } catch { return null; }
}
function paintTokenChip(status) {
  const chip = document.getElementById('tok-chip');
  if (!chip) return;
  if (!status || !status.present) {
    chip.textContent = '🔑 no token';
    chip.style.color = '#a33';
    chip.title = 'No bearer token in this tab — paste one before upload/repoint. Token lives only in this browser tab.';
  } else if (status.expired) {
    chip.textContent = '🔑 token EXPIRED';
    chip.style.color = '#a33';
    chip.title = 'Token in this tab expired at ' + status.expires_at + ' — paste a fresh one.';
  } else {
    chip.textContent = '🔑 ' + (status.email || 'token set');
    chip.style.color = '#0a7';
    chip.title = 'Valid until ' + (status.expires_at || 'unknown') + '. Token lives in this browser tab only — concurrent operators have their own.';
  }
}

// Build the Authorization header from the locally-stored token.
// Returns an empty object when no token, so handlers reject cleanly.
function authHeader() {
  const t = getStoredToken();
  return t ? { 'Authorization': 'Bearer ' + t } : {};
}

function statusFromLocalToken() {
  const tok = getStoredToken();
  if (!tok) return { present: false };
  const p = decodeTokenPayload(tok);
  const exp = p && typeof p.exp === 'number' ? p.exp : null;
  return {
    present: true,
    expired: exp != null && exp * 1000 < Date.now(),
    email: p && typeof p.email === 'string' ? p.email : null,
    expires_at: exp ? new Date(exp * 1000).toISOString() : null,
  };
}

async function tokenRefresh() {
  paintTokenChip(statusFromLocalToken());
}

async function setToken() {
  const tok = prompt('Paste a FRESH bearer token (1h TTL) from\\nhttps://platform.gushwork.ai/api/auth/token\\n\\nYour token lives ONLY in this browser tab. Different tabs (and other operators) have their own tokens.');
  if (tok == null) return;
  const t = tok.trim();
  if (!t) return;
  // Server validates expiry; if accepted, we store locally and start
  // sending it as Authorization on every subsequent Apply / repoint.
  try {
    const r = await fetch('/api/token', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: t })
    });
    const j = await r.json();
    if (!r.ok) { alert('Token rejected: ' + (j.error || ('HTTP ' + r.status))); return; }
    setStoredToken(t);
    paintTokenChip(j.status || statusFromLocalToken());
  } catch (err) {
    alert('Token set failed: ' + (err && err.message ? err.message : String(err)));
  }
}
if (document.getElementById('tok-chip')) tokenRefresh();

// Counts cards eligible for bulk apply. Cover/thumbnail/synthetic
// rows are excluded server-side; already-applied / currently-applying
// rows are skipped here so the count matches what will actually run.
function countApplicable(cards) {
  let eligible = 0, skippedUnsupported = 0, skippedAlreadyApplied = 0, skippedNoFile = 0;
  for (const card of cards) {
    if (!card.dataset.imageId) continue;
    if (card.dataset.synthetic === '1' || card.dataset.applyUnsupported === '1') {
      skippedUnsupported++;
      continue;
    }
    // Upload-mode cards without a dropped file yet are not eligible.
    // The server would reject them as "no image_local_path" anyway.
    if (card.dataset.upload === '1' && card.dataset.needsFile === '1') {
      skippedNoFile++;
      continue;
    }
    const s = stateOf.get(card.dataset.imageId) ?? 'pending';
    if (s === 'applied' || s === 'applying') {
      skippedAlreadyApplied++;
      continue;
    }
    eligible++;
  }
  return { eligible, skippedUnsupported, skippedAlreadyApplied, skippedNoFile, total: cards.length };
}

// Asks the operator to confirm a bulk apply. Resolves to true on
// confirm, false on cancel. The count line tells them exactly how
// many images will be processed and why others are skipped.
function confirmBulkApply(scopeLabel, counts) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;z-index:10001;';
    const skipLines = [];
    if (counts.skippedUnsupported > 0) skipLines.push(counts.skippedUnsupported + ' skipped (cover / thumbnail / synthetic — separate stormbreaker flow)');
    if (counts.skippedAlreadyApplied > 0) skipLines.push(counts.skippedAlreadyApplied + ' skipped (already applied or currently applying)');
    if (counts.skippedNoFile > 0) skipLines.push(counts.skippedNoFile + ' skipped (no file uploaded yet — drop a replacement first)');
    const skipHtml = skipLines.length
      ? '<ul style="margin:8px 0 0 18px;padding:0;color:#666;font-size:12px;">' + skipLines.map((l) => '<li>' + escapeHtml(l) + '</li>').join('') + '</ul>'
      : '';
    overlay.innerHTML = '<div style="background:#fff;color:#111;max-width:480px;width:92%;border-radius:8px;padding:22px 24px;box-shadow:0 18px 48px rgba(0,0,0,0.32);font-family:ui-sans-serif,system-ui,sans-serif;">'
      + '<div style="font-weight:600;font-size:15px;margin-bottom:10px;">Upload + Repoint — ' + escapeHtml(scopeLabel) + '</div>'
      + '<div style="font-size:13px;color:#222;">'
      + '<strong style="color:#0a7;">' + counts.eligible + '</strong> of ' + counts.total + ' image' + (counts.total === 1 ? '' : 's') + ' will be processed.'
      + skipHtml
      + '</div>'
      + (APPLY_DRY_RUN ? '<div style="margin-top:12px;background:#fef3c7;color:#92400e;padding:8px 10px;border-radius:4px;font-size:12px;">DRY-RUN — images ARE uploaded (new ids needed to preview), but page_info is NOT written. Backups + preview JSON are saved to out/.</div>' : '<div style="margin-top:12px;background:#fee2e2;color:#991b1b;padding:8px 10px;border-radius:4px;font-size:12px;">APPLY — this WILL PUT new page_info to production. A backup is saved per cluster first.</div>')
      + '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px;">'
      + '<button id="bca-cancel" style="padding:7px 14px;border:1px solid #d4d4d8;background:#fff;border-radius:4px;cursor:pointer;">Cancel</button>'
      + '<button id="bca-go" style="padding:7px 14px;border:0;background:#0a7;color:#fff;border-radius:4px;cursor:pointer;font-weight:600;"' + (counts.eligible === 0 ? ' disabled style="opacity:.5;cursor:not-allowed;"' : '') + '>' + (counts.eligible === 0 ? 'Nothing to apply' : (APPLY_DRY_RUN ? 'Run dry-run' : 'Apply')) + '</button>'
      + '</div></div>';
    document.body.appendChild(overlay);
    const close = (v) => { overlay.remove(); resolve(v); };
    overlay.querySelector('#bca-cancel').addEventListener('click', () => close(false));
    overlay.querySelector('#bca-go').addEventListener('click', () => close(counts.eligible > 0));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
  });
}

// Summary modal for cluster/run/picked apply — one row per image,
// click a row to drill into its full step trace.
function showApplySummaryModal(scopeLabel, results) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;z-index:10001;';
  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  const rows = results.map((r, i) => {
    const status = r.ok ? (r.dry_run ? 'DRY OK' : 'APPLIED') : 'FAILED';
    const colour = r.ok ? (r.dry_run ? '#b45309' : '#16a34a') : '#dc2626';
    return '<div class="bca-row" data-i="' + i + '" style="display:flex;justify-content:space-between;gap:10px;padding:7px 10px;border-bottom:1px solid #eee;cursor:pointer;font-family:ui-monospace,Menlo,monospace;font-size:12px;">'
      + '<span style="color:#666;flex:0 0 28px;">' + (i + 1) + '.</span>'
      + '<span style="flex:1;word-break:break-all;">' + escapeHtml(r.image_id_old || '?') + '</span>'
      + '<span style="font-weight:600;color:' + colour + ';">' + status + '</span>'
      + '</div>';
  }).join('');
  overlay.innerHTML = '<div style="background:#fff;color:#111;max-width:760px;width:92%;max-height:86vh;border-radius:8px;display:flex;flex-direction:column;box-shadow:0 18px 48px rgba(0,0,0,0.32);overflow:hidden;font-family:ui-sans-serif,system-ui,sans-serif;">'
    + '<div style="padding:14px 18px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;justify-content:space-between;gap:12px;">'
    + '<div style="font-weight:600;font-size:14px;">Upload + Repoint — ' + escapeHtml(scopeLabel) + ' (' + results.length + ' image' + (results.length === 1 ? '' : 's') + ')</div>'
    + '<button id="bca-close" style="background:none;border:0;font-size:22px;cursor:pointer;color:#555;line-height:1;">&times;</button>'
    + '</div>'
    + '<div style="padding:8px 18px;font-size:12px;color:#555;border-bottom:1px solid #f0f0f0;">'
    + '<span style="color:#16a34a;font-weight:600;">' + ok + ' ok</span>'
    + ' &middot; '
    + '<span style="color:#dc2626;font-weight:600;">' + failed + ' failed</span>'
    + ' &middot; click a row to see its step-by-step trace'
    + '</div>'
    + '<div style="overflow:auto;flex:1;">' + (rows || '<div style="padding:14px;color:#888;">No results.</div>') + '</div>'
    + '</div>';
  document.body.appendChild(overlay);
  overlay.querySelector('#bca-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelectorAll('.bca-row').forEach((row) => {
    row.addEventListener('click', () => {
      const i = Number(row.getAttribute('data-i'));
      const r = results[i];
      if (r) showApplyTraceModal(r.image_id_old || '?', r);
    });
  });
}

async function applyOne(imageId, opts) {
  opts = opts || {};
  const cur = stateOf.get(imageId) ?? 'pending';
  if (cur === 'applying') return;
  const card = document.querySelector('.result-card[data-image-id="' + CSS.escape(imageId) + '"]');
  if (!card) return;
  // Only truly synthetic non-cover/thumbnail ids have no resolvable
  // page_info reference site; the server flags these too, but we
  // short-circuit so the card fails instantly with a clear reason.
  if (card.dataset.applyUnsupported === '1') {
    stateOf.set(imageId, 'failed');
    paintCard(imageId, { error: 'No resolvable page_info reference for this synthetic id.' });
    refreshTotals();
    return;
  }
  // Upload-mode card with no file dropped yet → reject client-side so
  // the operator sees a clear message instead of a server 404.
  if (card.dataset.upload === '1' && card.dataset.needsFile === '1') {
    alert('Drop a replacement file for this slot before applying.');
    return;
  }
  // Single-card clicks honour the run-level mutex; bulk callers
  // (cluster / run / picked) already hold the mutex and pass
  // opts.bulk=true to bypass this re-check.
  if (!opts.bulk && applyBusyGuard()) return;
  if (!opts.bulk) setApplyBusy(true);
  stateOf.set(imageId, 'applying'); paintCard(imageId);
  try {
    const r = await fetch('/api/apply/image', {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, authHeader()),
      body: JSON.stringify({ run_id: RUN_ID, image_id: imageId, dry_run: APPLY_DRY_RUN })
    });
    const j = await r.json();
    if (!r.ok && !j.steps) throw new Error(j.reason || j.error || ('HTTP ' + r.status));
    // Show the trace modal regardless of ok/failure — operator wants
    // to see WHERE it would have failed too. State only flips to
    // 'applied' on a successful real (non-dry) run.
    showApplyTraceModal(imageId, j);
    if (j.ok && !j.dry_run) {
      stateOf.set(imageId, 'applied'); paintCard(imageId);
    } else if (j.ok && j.dry_run) {
      // Dry run passed — leave card in its prior state ('pending').
      stateOf.set(imageId, cur === 'applied' ? 'applied' : 'pending');
      paintCard(imageId);
    } else {
      stateOf.set(imageId, 'failed');
      paintCard(imageId, { error: 'apply failed: ' + (j.reason || 'unknown') });
    }
  } catch (err) {
    stateOf.set(imageId, 'failed');
    paintCard(imageId, { error: 'apply failed: ' + err.message });
  } finally {
    if (!opts.bulk) setApplyBusy(false);
  }
  refreshTotals();
}

// Modal showing the step-by-step trace returned by /api/apply/image.
// Lazy-injected on first use so the markup doesn't bloat every page.
function showApplyTraceModal(imageId, payload) {
  let overlay = document.getElementById('apply-trace-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'apply-trace-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);display:none;align-items:center;justify-content:center;z-index:10000;';
    overlay.innerHTML = '<div id="apply-trace-modal" style="background:#fff;color:#111;max-width:760px;width:92%;max-height:86vh;border-radius:8px;box-shadow:0 18px 48px rgba(0,0,0,0.32);display:flex;flex-direction:column;overflow:hidden;font:13px/1.45 ui-monospace,Menlo,monospace;"><div id="apply-trace-head" style="padding:14px 18px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;justify-content:space-between;gap:12px;font-family:ui-sans-serif,system-ui,sans-serif;"><div style="font-weight:600;font-size:14px;">Upload + Repoint — execution trace</div><button id="apply-trace-close" style="background:none;border:0;font-size:22px;cursor:pointer;color:#555;line-height:1;">&times;</button></div><div id="apply-trace-body" style="padding:14px 18px;overflow:auto;flex:1;"></div><div id="apply-trace-foot" style="padding:10px 18px;border-top:1px solid #e5e7eb;background:#fafafa;font-family:ui-sans-serif,system-ui,sans-serif;font-size:12px;color:#444;display:flex;justify-content:space-between;align-items:center;gap:12px;"></div></div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.style.display = 'none'; });
    overlay.querySelector('#apply-trace-close').addEventListener('click', () => { overlay.style.display = 'none'; });
  }
  const body = overlay.querySelector('#apply-trace-body');
  const foot = overlay.querySelector('#apply-trace-foot');
  const steps = Array.isArray(payload.steps) ? payload.steps : [];
  const colour = (s) => s === 'ok' ? '#16a34a' : s === 'skipped' ? '#b45309' : '#dc2626';
  const rows = steps.map((s) =>
    '<div style="display:grid;grid-template-columns:28px 1fr;gap:10px;padding:8px 0;border-bottom:1px dashed #eee;">'
    + '<div style="font-weight:600;color:#666;">' + s.n + '.</div>'
    + '<div><div style="font-weight:600;color:' + colour(s.status) + ';">'
    + escapeHtml(s.name) + ' <span style="font-weight:400;color:#888;text-transform:uppercase;font-size:11px;">[' + s.status + ']</span></div>'
    + '<div style="color:#333;margin-top:2px;word-break:break-all;">' + escapeHtml(s.detail) + '</div></div></div>'
  ).join('');
  const headBadge = payload.dry_run
    ? '<span style="background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;">DRY RUN</span>'
    : payload.ok
      ? '<span style="background:#dcfce7;color:#166534;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;">APPLIED</span>'
      : '<span style="background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;">FAILED</span>';
  body.innerHTML =
    '<div style="font-family:ui-sans-serif,system-ui,sans-serif;font-size:12px;color:#555;margin-bottom:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">'
    + headBadge
    + '<span>image_id: <code style="background:#f3f4f6;padding:1px 5px;border-radius:3px;">' + escapeHtml(imageId) + '</code></span>'
    + (payload.key_prefix ? '<span>key: <code style="background:#f3f4f6;padding:1px 5px;border-radius:3px;">' + escapeHtml(payload.key_prefix) + '</code></span>' : '')
    + '</div>'
    + (rows || '<div style="color:#888;">No steps recorded.</div>');
  const footMsg = payload.dry_run
    ? 'Image uploaded (new media id minted); page_info NOT written. Backup + preview JSON saved under out/repoint-*.'
    : payload.ok
      ? 'page_info repointed to the new image id and PUT to production. Per-cluster backup saved under out/repoint-backups.'
      : ('Failed: ' + escapeHtml(payload.reason || 'unknown'));
  foot.innerHTML = '<div>' + footMsg + '</div><div style="color:#888;">' + (payload.elapsed_ms != null ? payload.elapsed_ms + 'ms' : '') + '</div>';
  overlay.style.display = 'flex';
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Reconcile a batch of per-row results from /api/apply/cluster or
 * /api/apply/run back into the card state. Each entry is either
 *   { ok: true, image_id_old, image_id_new, … }
 * or
 *   { ok: false, image_id_old, reason }.
 */
function applyServerResults(results, opts) {
  opts = opts || {};
  for (const r of results) {
    const oldId = r.image_id_old || '';
    if (!oldId) continue;
    if (r.ok) {
      // Dry-run successes don't flip a card to 'applied' — nothing
      // was actually written to S3. Revert it to its prior state so
      // the operator can re-run for real once creds land.
      if (opts.dryRun || r.dry_run) {
        const prior = stateOf.get(oldId);
        if (prior === 'applying') stateOf.set(oldId, 'pending');
        paintCard(oldId);
      } else {
        stateOf.set(oldId, 'applied');
        paintCard(oldId);
      }
    } else {
      stateOf.set(oldId, 'failed');
      paintCard(oldId, { error: 'apply failed: ' + (r.reason || 'unknown') });
    }
  }
}

async function applyCluster(clusterId) {
  if (applyBusyGuard()) return;
  const cards = [...document.querySelectorAll('.result-card[data-cluster-id="' + CSS.escape(clusterId) + '"]')];
  const counts = countApplicable(cards);
  if (!(await confirmBulkApply('cluster ' + clusterId, counts))) return;
  setApplyBusy(true);
  for (const card of cards) {
    const id = card.dataset.imageId;
    if (!id) continue;
    if (card.dataset.synthetic === '1' || card.dataset.applyUnsupported === '1') continue;
    const s = stateOf.get(id) ?? 'pending';
    if (s === 'applied' || s === 'applying') continue;
    stateOf.set(id, 'applying'); paintCard(id);
  }
  try {
    const r = await fetch('/api/apply/cluster', {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, authHeader()),
      body: JSON.stringify({ run_id: RUN_ID, cluster_id: clusterId, dry_run: APPLY_DRY_RUN })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    applyServerResults(j.results || [], { dryRun: APPLY_DRY_RUN });
    showApplySummaryModal('cluster ' + clusterId, j.results || []);
  } catch (err) {
    for (const card of cards) {
      const id = card.dataset.imageId;
      if (!id) continue;
      if ((stateOf.get(id) ?? 'pending') !== 'applying') continue;
      stateOf.set(id, 'failed');
      paintCard(id, { error: 'apply failed: ' + err.message });
    }
  } finally {
    setApplyBusy(false);
  }
  refreshTotals();
}

// Revert restores page_info from the latest repoint backup. It shares
// the apply mutex (both write page_info — never run concurrently) and
// renders through the same summary/trace modal.
async function revertScope(url, payloadKey, scopeId, scopeLabel) {
  if (applyBusyGuard()) return;
  if (!APPLY_DRY_RUN &&
      !confirm('REVERT ' + scopeLabel + ' to its latest repoint backup?\\n\\nThis PUTs the prior page_info back to production. The current state is snapshotted first (out/repoint-backups/*-prerevert-*).')) {
    return;
  }
  setApplyBusy(true);
  try {
    const body = { dry_run: APPLY_DRY_RUN };
    body[payloadKey] = scopeId;
    const r = await fetch(url, {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, authHeader()),
      body: JSON.stringify(body)
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    showApplySummaryModal('revert ' + scopeLabel, j.results || []);
  } catch (err) {
    alert('Revert failed: ' + (err && err.message ? err.message : String(err)));
  } finally {
    setApplyBusy(false);
  }
}
function revertCluster(clusterId) {
  return revertScope('/api/revert/cluster', 'cluster_id', clusterId, 'cluster ' + clusterId);
}
function revertRun() {
  return revertScope('/api/revert/run', 'run_id', RUN_ID, 'run ' + RUN_ID);
}

async function applyAll() {
  if (applyBusyGuard()) return;
  const cards = [...document.querySelectorAll('.result-card[data-image-id]')];
  const counts = countApplicable(cards);
  if (!(await confirmBulkApply('entire run', counts))) return;
  setApplyBusy(true);
  for (const card of cards) {
    const id = card.dataset.imageId;
    if (!id) continue;
    if (card.dataset.synthetic === '1' || card.dataset.applyUnsupported === '1') continue;
    const s = stateOf.get(id) ?? 'pending';
    if (s === 'applied' || s === 'applying') continue;
    stateOf.set(id, 'applying'); paintCard(id);
  }
  try {
    const r = await fetch('/api/apply/run', {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, authHeader()),
      body: JSON.stringify({ run_id: RUN_ID, dry_run: APPLY_DRY_RUN })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    applyServerResults(j.results || [], { dryRun: APPLY_DRY_RUN });
    showApplySummaryModal('entire run', j.results || []);
  } catch (err) {
    for (const card of cards) {
      const id = card.dataset.imageId;
      if (!id) continue;
      if ((stateOf.get(id) ?? 'pending') !== 'applying') continue;
      stateOf.set(id, 'failed');
      paintCard(id, { error: 'apply failed: ' + err.message });
    }
  } finally {
    setApplyBusy(false);
  }
  refreshTotals();
}

// Per-image / per-cluster / all checkbox tree on the runs page. Synthetic
// cards have their checkbox disabled, but they still count toward
// cluster/all "checked" rendering — we filter them at apply time.
function onCardPick(cb) {
  const card = cb.closest('.result-card');
  if (!card) return;
  syncClusterPickFor(card.dataset.clusterId);
  syncAllPick();
  refreshPickedCount();
}
function onClusterPick(cb, clusterId) {
  const cards = document.querySelectorAll('.result-card[data-cluster-id="' + CSS.escape(clusterId) + '"]');
  for (const c of cards) {
    const x = c.querySelector('.rc-pick-cb');
    if (!x || x.disabled) continue;
    x.checked = cb.checked;
  }
  syncAllPick();
  refreshPickedCount();
}
function onAllPick(cb) {
  for (const x of document.querySelectorAll('.rc-pick-cb')) {
    if (!x.disabled) x.checked = cb.checked;
  }
  for (const x of document.querySelectorAll('.cs-pick-cb')) {
    x.checked = cb.checked;
    x.indeterminate = false;
  }
  refreshPickedCount();
}
function syncClusterPickFor(clusterId) {
  if (!clusterId) return;
  const cb = document.querySelector('.cluster-section[data-cluster-id="' + CSS.escape(clusterId) + '"] .cs-pick-cb');
  if (!cb) return;
  const cards = document.querySelectorAll('.result-card[data-cluster-id="' + CSS.escape(clusterId) + '"] .rc-pick-cb:not(:disabled)');
  let total = 0, checked = 0;
  for (const x of cards) { total++; if (x.checked) checked++; }
  cb.checked = total > 0 && checked === total;
  cb.indeterminate = checked > 0 && checked < total;
}
function syncAllPick() {
  const cb = document.getElementById('all-pick-cb');
  if (!cb) return;
  const cards = document.querySelectorAll('.rc-pick-cb:not(:disabled)');
  let total = 0, checked = 0;
  for (const x of cards) { total++; if (x.checked) checked++; }
  cb.checked = total > 0 && checked === total;
  cb.indeterminate = checked > 0 && checked < total;
}
function refreshPickedCount() {
  let n = 0;
  for (const x of document.querySelectorAll('.rc-pick-cb:not(:disabled)')) {
    if (x.checked) n++;
  }
  for (const id of ['picked-count', 'picked-count-bar']) {
    const el = document.getElementById(id);
    if (el) el.textContent = id === 'picked-count' ? (n + ' selected') : n;
  }
  const apply = document.getElementById('apply-all-btn');
  if (apply) apply.disabled = n === 0;
  const regen = document.getElementById('regen-all-btn');
  if (regen) regen.disabled = n === 0;
}
async function applyAllPicked() {
  if (applyBusyGuard()) return;
  const pickedCards = [];
  for (const card of document.querySelectorAll('.result-card[data-image-id]')) {
    const cb = card.querySelector('.rc-pick-cb');
    if (!cb || cb.disabled || !cb.checked) continue;
    pickedCards.push(card);
  }
  const counts = countApplicable(pickedCards);
  if (!(await confirmBulkApply(counts.total + ' selected', counts))) return;
  setApplyBusy(true);
  try {
    const ids = pickedCards
      .filter((c) => c.dataset.synthetic !== '1' && c.dataset.applyUnsupported !== '1')
      // Upload-mode cards without a dropped file would hit the
      // applyOne client-side alert("Drop a replacement file first")
      // for every row — skip them here so bulk apply only runs
      // against rows the server can actually process.
      .filter((c) => !(c.dataset.upload === '1' && c.dataset.needsFile === '1'))
      .map((c) => c.dataset.imageId)
      .filter((id) => {
        const s = stateOf.get(id) ?? 'pending';
        return s !== 'applied' && s !== 'applying';
      });
    // Each picked card hits /api/apply/image individually (re-using
    // the single-card endpoint) so the trace fan-out is identical
    // to clicking each card. opts.bulk=true means applyOne won't
    // try to acquire the mutex (we already hold it).
    const settled = await Promise.allSettled(ids.map((id) => applyOne(id, { bulk: true })));
    // No aggregated trace modal here — each card already opened its
    // own trace modal in sequence. Just surface a short toast-style
    // summary so the operator knows the bulk finished.
    const failed = settled.filter((s) => s.status === 'rejected').length;
    if (failed > 0) alert(failed + ' of ' + ids.length + ' picked applies failed. Check the failed cards for details.');
  } finally {
    setApplyBusy(false);
  }
}
async function regenAllPicked() {
  const picked = [];
  for (const card of document.querySelectorAll('.result-card[data-image-id]')) {
    const cb = card.querySelector('.rc-pick-cb');
    if (!cb || cb.disabled || !cb.checked) continue;
    const id = card.dataset.imageId;
    if (!id) continue;
    picked.push(id);
  }
  if (picked.length === 0) return;
  // Disable the button so a stray click doesn't double-fire while a
  // batch is in flight.
  const btn = document.getElementById('regen-all-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Regenerating ' + picked.length + '…'; }
  try {
    await Promise.all(picked.map((id) => regenOne(id)));
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '↻ Regenerate selected'; }
  }
}

// Per-card zoom button: opens the existing lightbox with the new image.
function zoomCard(imageId, ev) {
  if (ev) ev.stopPropagation();
  try {
    const card = document.querySelector('.result-card[data-image-id="' + CSS.escape(imageId) + '"]');
    if (!card) { console.warn('[zoomCard] no card for', imageId); return; }
    const img = card.querySelector('.rc-img img');
    const src = img ? img.src : '';
    if (!src) { console.warn('[zoomCard] no img src for', imageId); return; }
    const asset = card.querySelector('.pill') ? card.querySelector('.pill').textContent : '';
    lbOpen(null, src, (asset || '') + ' · ' + imageId);
  } catch (e) {
    console.error('[zoomCard] failed for', imageId, e);
  }
}

// Compare modal: old (live CDN URL from media_registry) vs new (from CSV).
// When the old image isn't found (no media_registry hit), the left
// pane falls back to a "no live image found" placeholder so the
// button still gives the operator something to look at.
function openCompare(imageId) {
  try {
    const card = document.querySelector('.result-card[data-image-id="' + CSS.escape(imageId) + '"]');
    if (!card) { console.warn('[openCompare] no card for', imageId); return; }
    const img = card.querySelector('.rc-img img');
    const newSrc = img ? img.src : '';
    const oldSrc = card.dataset.oldUrl || '';
    const overlay = document.getElementById('cmp-overlay');
    const oldEl = document.getElementById('cmp-old');
    const oldPh = document.getElementById('cmp-old-ph');
    const newEl = document.getElementById('cmp-new');
    const newPh = document.getElementById('cmp-new-ph');
    const titleEl = document.getElementById('cmp-title');
    const metaEl = document.getElementById('cmp-meta');
    if (!overlay || !oldEl || !newEl) {
      console.error('[openCompare] modal DOM missing — overlay=', !!overlay, 'old=', !!oldEl, 'new=', !!newEl);
      return;
    }
    // Old pane: prefer the saved live CDN url; placeholder otherwise.
    if (oldSrc) {
      oldEl.src = oldSrc;
      oldEl.style.display = '';
      if (oldPh) oldPh.style.display = 'none';
    } else {
      oldEl.removeAttribute('src');
      oldEl.style.display = 'none';
      if (oldPh) {
        oldPh.style.display = 'flex';
        const sub = oldPh.querySelector('.sub');
        if (sub) sub.textContent = 'No live image recorded for this slot.';
      }
    }
    // New pane: render whatever src we have (Compare always opens —
    // even when the new file is gone the old one is independently
    // valuable, so we never bail just because newSrc is empty).
    if (newSrc) {
      newEl.src = newSrc;
      newEl.style.display = '';
      if (newPh) newPh.style.display = 'none';
    } else {
      newEl.removeAttribute('src');
      newEl.style.display = 'none';
      if (newPh) newPh.style.display = 'flex';
    }
    // If the new pane fetches a broken /preview (file pruned, Replicate
    // expired), swap to the placeholder dynamically so the operator
    // sees a clear message instead of a broken-image icon.
    if (newSrc) {
      newEl.onerror = () => {
        newEl.onerror = null;
        newEl.style.display = 'none';
        if (newPh) {
          newPh.style.display = 'flex';
          const sub = newPh.querySelector('.sub');
          if (sub) sub.textContent = 'New image bytes no longer available (retention sweep ran or Replicate URL expired). Re-Regenerate to mint a fresh copy.';
        }
      };
    }
    if (titleEl) titleEl.textContent = 'Compare — ' + imageId;
    const asset = card.querySelector('.pill') ? card.querySelector('.pill').textContent : '';
    if (metaEl) metaEl.textContent = asset;
    overlay.classList.add('open');
  } catch (e) {
    console.error('[openCompare] failed for', imageId, e);
  }
}
function closeCompare() {
  document.getElementById('cmp-overlay').classList.remove('open');
}
function closeCompareOnBackdrop(ev) {
  if (ev.target === ev.currentTarget) closeCompare();
}

async function regenOne(imageId, customInstructions) {
  const card = document.querySelector('.result-card[data-image-id="' + CSS.escape(imageId) + '"]');
  if (!card) return;
  const btn = card.querySelector('.btn-regen');
  if (btn) {
    btn.innerHTML = '<span class="spinner"></span> Regenerating…';
    btn.disabled = true;
  }
  // Drop a themed shimmer over the existing image so the operator
  // sees something is in flight (the actual call can take 30–60s).
  card.classList.add('regenerating');
  try {
    const body = { run_id: RUN_ID, image_id: imageId, cluster_id: card.dataset.clusterId };
    // Only include custom_instructions when actually supplied — the
    // empty case must hit the fast no-op path on the server.
    if (typeof customInstructions === 'string' && customInstructions.trim().length > 0) {
      body.custom_instructions = customInstructions.trim();
    }
    const r = await fetch('/api/regen-one', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(await r.text());
    const j = await r.json();
    const img = card.querySelector('.rc-img img');
    if (img && (j.image_url_new || j.image_local_path)) {
      // Route through our /preview/ endpoint so the swapped image
      // stays loadable past the Replicate signed-URL TTL — the
      // regen handler updated the parent CSV in place, so /preview
      // serves the new local file. Cache-buster on the query side
      // forces the browser to re-fetch instead of showing the
      // stale image bytes still in cache for this src.
      img.src = '/runs/' + encodeURIComponent(RUN_ID) + '/preview/' + encodeURIComponent(imageId) + '?t=' + Date.now();
    }
    // A regenerated image returns to pending so the operator decides
    // whether to Apply this one.
    stateOf.set(imageId, 'pending');
    paintCard(imageId);
  } catch (err) {
    stateOf.set(imageId, 'failed');
    paintCard(imageId, { error: 'regenerate failed: ' + err.message });
  } finally {
    card.classList.remove('regenerating');
    if (btn) { btn.innerHTML = '↻ Regenerate'; btn.disabled = false; }
  }
  refreshTotals();
}

// ── Regenerate (custom instructions) modal ──
// Holds the image_id while the modal is open so the Cancel/Submit
// buttons know which card to act on. Cleared on close.
let rcImageIdInFlight = null;
function rcOpen(imageId) {
  const card = document.querySelector('.result-card[data-image-id="' + CSS.escape(imageId) + '"]');
  if (!card) return;
  rcImageIdInFlight = imageId;
  const pillEl = card.querySelector('.pill');
  const assetLabel = pillEl ? pillEl.textContent : '';
  document.getElementById('rc-meta').textContent = (assetLabel || '') + ' · ' + imageId;
  const ta = document.getElementById('rc-text');
  ta.value = '';
  document.getElementById('rc-overlay').classList.add('open');
  // Defer focus until after the open-transition starts.
  setTimeout(() => { try { ta.focus(); } catch (_) { /* */ } }, 50);
}
function rcClose() {
  document.getElementById('rc-overlay').classList.remove('open');
  rcImageIdInFlight = null;
}
function rcBackdrop(ev) { if (ev.target === ev.currentTarget) rcClose(); }
async function rcSubmit() {
  const id = rcImageIdInFlight;
  if (!id) return;
  const text = (document.getElementById('rc-text').value || '').trim();
  // Closing first means the operator can keep using the page while
  // the (~30-60s) regen runs — the in-page card shimmer already
  // signals what's in flight.
  rcClose();
  await regenOne(id, text);
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
  // Bulk button now respects the checkbox tree, not just pending count.
  refreshPickedCount();
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
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // Close whichever modal is on top, in priority order.
  const rc = document.getElementById('rc-overlay');
  if (rc && rc.classList.contains('open')) { rcClose(); return; }
  const cmp = document.getElementById('cmp-overlay');
  if (cmp && cmp.classList.contains('open')) { closeCompare(); return; }
  lbClose();
});

if (document.getElementById('apply-all-btn')) refreshTotals();
// Prepare-stage progress chip initial paint. Safe no-op when the
// run isn't in prepare mode (function early-returns on RUN_STAGE check).
updateUploadProgress();

// ── Delegated click handler for result-cards ──
// Inline onclick attributes were unreliable across some content/escape
// edge cases; one document-level listener that walks the click target
// is far more robust and supports cards added later.
document.addEventListener('click', (ev) => {
  const t = ev.target;
  if (!(t instanceof Element)) return;
  // Image click → zoom (lightbox).
  const img = t.closest('.rc-img .rc-preview-img');
  if (img && t.tagName !== 'BUTTON') {
    const card = img.closest('.result-card');
    if (card && card.dataset.imageId) { console.log('[click] zoom via image', card.dataset.imageId); zoomCard(card.dataset.imageId, ev); }
    return;
  }
  // Card-action triggers. We include <a> alongside <button> because
  // "↻ Custom…" is styled as a hyperlink, and we don't want it to
  // navigate (no href), so its onclick goes through here too. The
  // selector list MUST stay in sync with the action attributes we
  // render in the card template — adding a new data-* attr without
  // adding it here means the button looks live but does nothing.
  const btn = t.closest('[data-zoom],[data-compare],[data-regen],[data-regen-custom],[data-apply],[data-replace],[data-clear]');
  if (!btn) return;
  const card = btn.closest('.result-card');
  if (!card) return;
  const id = card.dataset.imageId;
  if (!id) { console.warn('[click] action button found but card has no data-image-id'); return; }
  console.log('[click] action=', btn.dataset && Object.keys(btn.dataset).find((k) => k.startsWith('regen') || k.startsWith('compare') || k.startsWith('apply') || k.startsWith('zoom') || k.startsWith('replace') || k.startsWith('clear')), 'imageId=', id);
  if (btn.matches('[data-zoom]'))          { zoomCard(id, ev);  return; }
  if (btn.matches('[data-compare]'))       { openCompare(id);   return; }
  if (btn.matches('[data-regen]'))         { regenOne(id);      return; }
  if (btn.matches('[data-regen-custom]'))  { ev.preventDefault(); rcOpen(id); return; }
  if (btn.matches('[data-apply]'))         { applyOne(id);      return; }
  if (btn.matches('[data-replace]'))       { triggerUploadFilePicker(id); return; }
  if (btn.matches('[data-clear]'))         { clearUploadedFile(id); return; }
});

// ── Upload-mode stage handling (prepare vs apply) ────────────────────
// The runPage URL query param decides which view we're in. The
// prepare view focuses purely on drops; the apply view shows the
// full Apply / Regen / Token toolbox. RUN_STAGE is declared at the
// very top of the script so updateUploadProgress (called BEFORE
// this block during init) can read it without hitting TDZ — the
// previous setup threw at the call site and silently killed the
// rest of the script, leaving every let after that point
// uninitialised and inline onclick="dzClick(event)" with TDZ for
// __dzActiveImageId.

function updateUploadProgress() {
  if (window.RUN_STAGE !== 'prepare') return;
  const total = document.querySelectorAll('.result-card.upload-mode').length;
  const done = document.querySelectorAll('.result-card.upload-mode:not([data-needs-file="1"])').length;
  const lbl = document.getElementById('dz-uploaded-count');
  if (lbl) lbl.textContent = String(done);
  const btn = document.getElementById('prepare-continue-btn');
  if (btn) {
    btn.disabled = done === 0;
    btn.textContent = done === 0
      ? 'Continue to Apply'
      : done === total
        ? 'Continue to Apply (' + done + '/' + total + ' ready) →'
        : 'Continue to Apply (' + done + '/' + total + ' ready, ' + (total - done) + ' will be skipped) →';
  }
}

function goToApplyStage() {
  // Drop the ?stage=prepare and reload — server returns the full
  // Apply view with the same on-disk file state.
  const url = new URL(window.location.href);
  url.searchParams.delete('stage');
  window.location.href = url.pathname + (url.search ? url.search : '') + url.hash;
}

// ── Upload-mode drag-and-drop ───────────────────────────────────────
// Strategy:
//  1. Window-level dragenter/dragover/drop suppress the BROWSER
//     default ("open the file in a new tab") for ANY file-drop on
//     this page. Without these, drops that miss the dropzone (e.g.
//     on the page header or padding around the card) navigate to
//     the dragged file's URL — the operator's image opens in a
//     new tab instead of uploading.
//  2. Per-dropzone behaviour is wired via INLINE attributes
//     (onclick / ondragover / ondrop) on the <div class="rc-dropzone">
//     element itself. Inline handlers are 100%-reliable across
//     event-delegation edge-cases and dynamic re-renders, and they
//     preserve the user-gesture context required for the file
//     picker to open on click.
const ACCEPTED_MIMES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// Window-level default-suppression. We preventDefault on any drag
// event whose dataTransfer carries files, so the browser doesn't
// initiate the navigation-to-file flow for drops outside dropzones.
// Non-file drags (text, in-page drag-reorder, etc.) pass through.
function dzWindowSuppress(ev) {
  if (ev.dataTransfer && ev.dataTransfer.types && Array.prototype.includes.call(ev.dataTransfer.types, 'Files')) {
    ev.preventDefault();
  }
}
window.addEventListener('dragenter', dzWindowSuppress);
window.addEventListener('dragover', dzWindowSuppress);
window.addEventListener('drop', dzWindowSuppress);

// Persistent hidden file input — created ONCE at page load and
// reused for every click-to-browse. Dynamically-created-and-immediately-
// clicked inputs are unreliable across browsers (some refuse to open
// the picker until the next event loop tick; some require the
// element to have been part of the DOM for at least one frame).
// One-off + reuse fixes both.
let __dzFileInput = null;
let __dzActiveImageId = null;
function ensureDzFileInput() {
  if (__dzFileInput && __dzFileInput.parentNode) return __dzFileInput;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = ACCEPTED_MIMES.join(',');
  input.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;width:1px;height:1px;pointer-events:none;';
  input.addEventListener('change', () => {
    const f = input.files && input.files[0];
    const id = __dzActiveImageId;
    __dzActiveImageId = null;
    input.value = ''; // allow re-picking the same file
    if (f && id) handleUploadFile(id, f);
  });
  document.body.appendChild(input);
  __dzFileInput = input;
  console.log('[upload] persistent file input ready');
  return input;
}

// Per-dropzone inline handlers. Exposed on window so the inline
// onclick / ondragover attributes can resolve them.
function dzClick(ev) {
  const dz = ev.currentTarget;
  console.log('[upload] dzClick fired, dz=', dz);
  if (!dz) return;
  if (dz.classList.contains('uploading')) { console.log('[upload] skipped — uploading in progress'); return; }
  const imageId = dz.getAttribute('data-image-id');
  if (!imageId) { console.warn('[upload] dropzone has no data-image-id'); return; }
  __dzActiveImageId = imageId;
  const input = ensureDzFileInput();
  console.log('[upload] triggering file picker for', imageId);
  input.click();
}
function dzDragEnter(ev) {
  ev.preventDefault();
  ev.currentTarget && ev.currentTarget.classList.add('dragover');
}
function dzDragOver(ev) {
  ev.preventDefault();
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
  ev.currentTarget && ev.currentTarget.classList.add('dragover');
}
function dzDragLeave(ev) {
  // dragleave fires when the mouse leaves the dropzone OR moves to
  // a child element. We only clear the highlight when the mouse
  // truly leaves the dropzone bounds (related target is null or
  // outside this dropzone).
  const dz = ev.currentTarget;
  if (!dz) return;
  const related = ev.relatedTarget;
  if (related && dz.contains(related)) return;
  dz.classList.remove('dragover');
}
function dzDrop(ev) {
  ev.preventDefault();
  const dz = ev.currentTarget;
  if (!dz) return;
  dz.classList.remove('dragover');
  const imageId = dz.dataset.imageId;
  if (!imageId) return;
  const file = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
  if (file) handleUploadFile(imageId, file);
}
// Expose to global scope so inline onclick="dzClick(event)" etc.
// resolve regardless of script-block scoping.
window.dzClick = dzClick;
window.dzDragEnter = dzDragEnter;
window.dzDragOver = dzDragOver;
window.dzDragLeave = dzDragLeave;
window.dzDrop = dzDrop;

// Pre-create the persistent hidden file input on page load so the
// first dropzone click doesn't pay the create-and-attach cost.
// Only meaningful for upload-mode runs but harmless elsewhere.
if (document.querySelector('.rc-dropzone, .result-card[data-upload="1"]')) ensureDzFileInput();

// Legacy entry-point for the per-card Replace button (and any
// other inline trigger). Reuses the persistent file input.
function triggerUploadFilePicker(imageId) {
  __dzActiveImageId = imageId;
  const input = ensureDzFileInput();
  console.log('[upload] triggering file picker for', imageId);
  input.click();
}

async function handleUploadFile(imageId, file) {
  const card = document.querySelector('.result-card[data-image-id="' + CSS.escape(imageId) + '"]');
  if (!card) return;
  // Client-side gate so the operator gets fast feedback for the
  // obvious wrong-file cases. Server still re-validates everything.
  if (!ACCEPTED_MIMES.includes(file.type)) {
    paintDropError(card, 'unsupported file type — only PNG, JPEG, and WebP are accepted (got ' + (file.type || 'unknown') + ')');
    return;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    paintDropError(card, 'file too large (' + (file.size / 1024 / 1024).toFixed(1) + ' MB; max 10 MB)');
    return;
  }
  paintDropUploading(card, 0, file.name);
  try {
    const url = '/runs/' + encodeURIComponent(RUN_ID) + '/upload/' + encodeURIComponent(imageId);
    // XHR (not fetch) so we can read upload progress events.
    const j = await xhrUpload(url, file, (pct) => paintDropUploading(card, pct, file.name));
    if (!j || j.ok !== true) throw new Error((j && j.error) || 'upload failed');
    paintDropApplied(card, j);
  } catch (err) {
    paintDropError(card, err && err.message ? err.message : String(err));
  }
}

function xhrUpload(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('content-type', file.type);
    // HTTP headers must be ISO-8859-1. URL-encode the filename so
    // non-Latin1 chars (emoji, accents, CJK, smart quotes, etc.)
    // don't throw a synchronous setRequestHeader error before the
    // body is even streamed. Server decodes via decodeURIComponent.
    try { xhr.setRequestHeader('x-original-filename', encodeURIComponent(file.name || '')); } catch (_e) { /* skip */ }
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      try {
        const j = JSON.parse(xhr.responseText || '{}');
        if (xhr.status >= 200 && xhr.status < 300) resolve(j);
        else reject(new Error(j.error || ('HTTP ' + xhr.status)));
      } catch (e) {
        reject(new Error('invalid JSON in response (HTTP ' + xhr.status + ')'));
      }
    };
    xhr.onerror = () => reject(new Error('network error'));
    xhr.ontimeout = () => reject(new Error('upload timed out'));
    xhr.send(file);
  });
}

function paintDropUploading(card, pct, name) {
  const dz = card.querySelector('.rc-dropzone');
  if (!dz) return;
  dz.classList.remove('dragover', 'error');
  dz.classList.add('uploading');
  dz.innerHTML =
    '<div class="dz-icon">↑</div>' +
    '<div class="dz-text">Uploading…</div>' +
    '<div class="dz-sub">' + escapeHtml(name) + '</div>' +
    '<div class="dz-progress">' + pct + '%</div>';
}
function paintDropError(card, msg) {
  const dz = card.querySelector('.rc-dropzone');
  if (!dz) return;
  dz.classList.remove('dragover', 'uploading');
  dz.classList.add('error');
  dz.innerHTML =
    '<div class="dz-icon">⚠</div>' +
    '<div class="dz-text">Upload failed</div>' +
    '<div class="dz-err-msg">' + escapeHtml(msg) + '</div>' +
    '<div class="dz-sub" style="margin-top:4px">Click here to try again</div>';
  // Re-arm the dropzone after a moment so a subsequent click /
  // drop kicks off a fresh upload attempt.
  setTimeout(() => { dz.classList.remove('error'); }, 4000);
}
function paintDropApplied(card, info) {
  card.dataset.needsFile = '';
  card.removeAttribute('data-needs-file');
  updateUploadProgress();
  // Swap the dropzone for the preview image.
  const rcImg = card.querySelector('.rc-img');
  if (rcImg) {
    rcImg.innerHTML =
      '<img class="rc-preview-img" src="' + info.preview_url + '" alt="" loading="lazy">' +
      '<button class="rc-zoom" type="button" data-zoom title="Zoom in"><span aria-hidden="true">⤢</span></button>';
  }
  // Reveal Replace + Clear + Compare, enable Apply.
  const replaceBtn = card.querySelector('[data-replace]');
  const clearBtn = card.querySelector('[data-clear]');
  const compareBtn = card.querySelector('[data-compare]');
  if (replaceBtn) replaceBtn.style.display = '';
  if (clearBtn) clearBtn.style.display = '';
  if (compareBtn) compareBtn.style.display = '';
  const applyBtn = card.querySelector('[data-apply]');
  if (applyBtn) {
    applyBtn.disabled = false;
    applyBtn.removeAttribute('aria-disabled');
    applyBtn.title = 'Upload this image via the Gushwork media API, then repoint page_info to the new id.';
  }
  // Surface an aspect-mismatch warning if present (yellow banner
  // inside the card body, just below the description).
  const existing = card.querySelector('.upload-warn');
  if (existing) existing.remove();
  if (info.aspect_warning) {
    const warn = document.createElement('div');
    warn.className = 'upload-warn';
    warn.textContent = '⚠ ' + info.aspect_warning;
    const body = card.querySelector('.rc-body');
    if (body) body.insertBefore(warn, body.querySelector('.rc-actions'));
  }
}

async function clearUploadedFile(imageId) {
  if (!confirm('Remove the uploaded file for this slot?')) return;
  const card = document.querySelector('.result-card[data-image-id="' + CSS.escape(imageId) + '"]');
  if (!card) return;
  try {
    const r = await fetch('/runs/' + encodeURIComponent(RUN_ID) + '/upload/' + encodeURIComponent(imageId), { method: 'DELETE' });
    const j = await r.json();
    if (!r.ok || j.ok !== true) throw new Error(j.error || ('HTTP ' + r.status));
    // Reset the card back to the dropzone state.
    card.setAttribute('data-needs-file', '1');
    updateUploadProgress();
    const rcImg = card.querySelector('.rc-img');
    if (rcImg) {
      rcImg.innerHTML =
        '<div class="rc-dropzone" data-dropzone data-image-id="' + escapeHtml(imageId) + '"' +
        ' onclick="dzClick(event)" ondragenter="dzDragEnter(event)" ondragover="dzDragOver(event)"' +
        ' ondragleave="dzDragLeave(event)" ondrop="dzDrop(event)">' +
        '<div class="dz-icon">↑</div>' +
        '<div class="dz-text">Drop file here</div>' +
        '<div class="dz-sub">or click to browse — png · jpeg · webp · ≤10MB</div>' +
        '</div>';
    }
    const replaceBtn = card.querySelector('[data-replace]');
    const clearBtn = card.querySelector('[data-clear]');
    const compareBtn = card.querySelector('[data-compare]');
    if (replaceBtn) replaceBtn.style.display = 'none';
    if (clearBtn) clearBtn.style.display = 'none';
    if (compareBtn) compareBtn.style.display = 'none';
    const applyBtn = card.querySelector('[data-apply]');
    if (applyBtn) {
      applyBtn.disabled = true;
      applyBtn.setAttribute('aria-disabled', 'true');
    }
    const warn = card.querySelector('.upload-warn');
    if (warn) warn.remove();
  } catch (err) {
    alert('failed to clear: ' + (err && err.message ? err.message : err));
  }
}

${state.done ? "" : `
const es = new EventSource('/runs/${esc(id)}/events');
es.onmessage = (ev) => {
  try {
    const { text } = JSON.parse(ev.data);
    logEl.textContent += text;
    logEl.scrollTop = logEl.scrollHeight;
    if (typeof onLogStream === 'function') onLogStream(text);
  } catch {}
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

// ────────────────────────────────────────────────────────────────────────
// Download endpoints — per-image + bulk ZIP, both fully streaming
// ────────────────────────────────────────────────────────────────────────

const SAFE_FILE_RE = /[^A-Za-z0-9._-]+/g;
function safeForFs(s: string, max = 80): string {
  const cleaned = (s || "").replace(SAFE_FILE_RE, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.slice(0, max) || "untitled";
}
function extOf(p: string): string {
  const m = /\.([a-zA-Z0-9]{2,5})$/.exec(p);
  return m && m[1] ? m[1].toLowerCase() : "png";
}
const IMAGE_CT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  webp: "image/webp", gif: "image/gif", avif: "image/avif",
};

/**
 * Resolve a CSV row to a Node Readable stream of the image bytes.
 *
 * Priority:
 *   1. image_local_path on disk — the regen pipeline saved a copy at
 *      run time, so it works for the full retention window.
 *   2. image_url_new (Replicate signed URL) — only useful while the
 *      run is fresh. Replicate signs delivery URLs for ~1h, so we
 *      gate this branch on `generated_at_utc` to avoid burning a
 *      TCP timeout on every miss for an old run.
 *
 * Both paths stream; the response is never buffered into memory.
 * Returns either the stream + (when known) size and stat metadata
 * for caching headers, or null when neither source works.
 */
interface OpenedImage {
  stream: Readable;
  size?: number;
  ext: string;
  /** Populated only for the local-file path; lets the caller emit
   *  Last-Modified / ETag headers for a 304 Not Modified flow. */
  localMtimeMs?: number;
}
async function openImageStream(
  row: { image_local_path?: string; image_url_new?: string; generated_at_utc?: string },
  retentionCfg: RetentionConfig = loadRetentionConfig(),
): Promise<OpenedImage | null> {
  const local = row.image_local_path?.trim();
  if (local) {
    try {
      const abs = path.resolve(local);
      // Allow files under either the current cwd OR the configured
      // RUN_OUT_DIR. Older CSV rows were written when cwd === out's
      // parent, so abs.startsWith(cwd) was equivalent to "under
      // runOutDir". After the Railway volume rollout, runOutDir
      // resolves to /data/runs, but cwd is /app — the cwd check
      // alone would reject every legitimate file on the volume.
      const cwdRoot = path.resolve(process.cwd());
      const outRoot = runOutDir();
      if (abs.startsWith(cwdRoot) || abs.startsWith(outRoot)) {
        const st = statSync(abs);
        if (st.isFile()) {
          return {
            stream: createReadStream(abs),
            size: st.size,
            ext: extOf(abs),
            localMtimeMs: st.mtimeMs,
          };
        }
      }
    } catch { /* fall through to remote */ }
  }
  // Fallback: try the basename of the recorded local path against
  // runOutDir(). Older CSV rows persisted absolute paths that no
  // longer exist verbatim after a redeploy (e.g. /app/out/runs/<id>/
  // images/foo.webp written when runOutDir was <cwd>/out), but the
  // file itself was migrated alongside the manifest to /data/runs/
  // runs/<id>/images/foo.webp. Re-resolve the basename + run subdir
  // against the current runOutDir so shared run URLs keep working.
  if (local) {
    try {
      const candidate = rehydrateLocalImagePath(local);
      if (candidate) {
        const st = statSync(candidate);
        if (st.isFile()) {
          return {
            stream: createReadStream(candidate),
            size: st.size,
            ext: extOf(candidate),
            localMtimeMs: st.mtimeMs,
          };
        }
      }
    } catch { /* fall through to remote */ }
  }
  const remote = row.image_url_new?.trim();
  if (remote && /^https?:\/\//.test(remote)) {
    // Skip the remote round-trip when the URL is almost certainly
    // expired. Replicate signs delivery URLs for roughly an hour;
    // requesting after that just costs us a 5–10s timeout per file.
    const generatedMs = row.generated_at_utc ? Date.parse(row.generated_at_utc) : NaN;
    if (Number.isFinite(generatedMs)) {
      const ageH = (Date.now() - generatedMs) / 3600_000;
      if (ageH > retentionCfg.replicateUrlTtlHours) return null;
    }
    const stream = await fetchAsStream(remote);
    if (stream) return { stream, ext: extOf(new URL(remote).pathname) };
  }
  return null;
}

/**
 * Stream a remote URL as a Readable without buffering. Uses the
 * native http/https client (no axios) so the response body flows
 * straight through with no intermediate ArrayBuffer.
 */
function fetchAsStream(url: string, maxRedirects = 3): Promise<Readable | null> {
  return new Promise((resolve) => {
    let u: URL;
    try { u = new URL(url); } catch { return resolve(null); }
    const lib = u.protocol === "https:" ? httpsRequest : httpRequest;
    const req = lib(u, { method: "GET" }, (resp) => {
      const code = resp.statusCode ?? 0;
      if (code >= 300 && code < 400 && resp.headers.location && maxRedirects > 0) {
        const next = new URL(resp.headers.location, u).toString();
        resp.resume();
        fetchAsStream(next, maxRedirects - 1).then(resolve);
        return;
      }
      if (code < 200 || code >= 300) {
        resp.resume();
        resolve(null);
        return;
      }
      resolve(resp);
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

/**
 * Re-resolve a CSV-stored image_local_path against the current
 * runOutDir(). Image paths land in CSV as absolute (e.g.
 * /app/out/runs/<id>/images/<basename>); after a Railway redeploy
 * the volume is mounted at /data/runs, so the verbatim path 404s
 * but the bytes are present at /data/runs/runs/<id>/images/<basename>.
 *
 * Walks back from the file to find the run-scoped subtree
 * ("runs/<id>/images/<basename>" or "images/<basename>") and joins it
 * onto runOutDir(). Returns null if no candidate exists.
 */
function rehydrateLocalImagePath(stored: string): string | null {
  // Try to extract the trailing `runs/<runId>/images/<basename>` /
  // `images/<basename>` substring out of the stored absolute path.
  const m = stored.match(/(?:^|\/)(runs\/[a-f0-9]+\/images\/[^/]+|images\/[^/]+\/[^/]+)$/i);
  if (!m || !m[1]) return null;
  return path.join(runOutDir(), m[1]);
}

/** Inline-serving counterpart of runDownloadOne — same source-of-
 * truth (openImageStream: local-first, remote-fallback), but no
 * Content-Disposition: attachment header, so the response can be the
 * src= target of an <img> tag. Used by the runs page card previews
 * so shared run URLs keep rendering after the Replicate signed URL
 * window expires (~1 hour). */
async function runPreviewOne(
  req: IncomingMessage,
  res: ServerResponse,
  runId: string,
  imageId: string,
) {
  let state = RUNS.get(runId) ?? null;
  if (!state) state = await tryReconstructRunFromDisk(runId);
  if (!state || !state.csvPath) {
    send(res, 404, "text/plain", "run or csv not found");
    return;
  }
  const rows = await readRunCsvOrEmpty(state.csvPath);
  const row = rows.find((r) => r.image_id === imageId);
  if (!row) {
    send(res, 404, "text/plain", `image ${imageId} not in run`);
    return;
  }
  const opened = await openImageStream(row);
  if (!opened) {
    // 410 Gone — the file's been pruned by retention and the
    // Replicate URL has expired. The card-rendering JS treats any
    // image error by leaving the placeholder visible.
    send(res, 410, "text/plain", "image bytes no longer available");
    return;
  }
  const headers: Record<string, string> = {
    "content-type": IMAGE_CT[opened.ext] ?? "application/octet-stream",
    // Long cache — image content for a finished run is immutable,
    // and the URL is keyed by image_id. Re-regen creates a NEW
    // child run with a new id, so this caches cleanly.
    "cache-control": "private, max-age=86400",
    "accept-ranges": "none",
  };
  if (opened.size != null) headers["content-length"] = String(opened.size);
  if (opened.localMtimeMs != null && opened.size != null) {
    const lastMod = new Date(opened.localMtimeMs).toUTCString();
    const etag = `W/"${opened.size.toString(16)}-${Math.floor(opened.localMtimeMs).toString(16)}"`;
    headers["last-modified"] = lastMod;
    headers["etag"] = etag;
    const ifNoneMatch = req.headers["if-none-match"];
    const ifModSince = req.headers["if-modified-since"];
    const matches = (typeof ifNoneMatch === "string" && ifNoneMatch === etag)
      || (typeof ifModSince === "string"
        && !Number.isNaN(Date.parse(ifModSince))
        && opened.localMtimeMs <= Date.parse(ifModSince) + 999);
    if (matches) {
      try { opened.stream.destroy(); } catch { /* */ }
      res.writeHead(304, headers);
      res.end();
      return;
    }
  }
  if (req.method === "HEAD") {
    try { opened.stream.destroy(); } catch { /* */ }
    res.writeHead(200, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  opened.stream.pipe(res);
  opened.stream.on("error", () => { try { res.destroy(); } catch { /* */ } });
}

async function runDownloadOne(
  req: IncomingMessage,
  res: ServerResponse,
  runId: string,
  imageId: string,
) {
  let state = RUNS.get(runId) ?? null;
  if (!state) state = await tryReconstructRunFromDisk(runId);
  if (!state || !state.csvPath) {
    send(res, 404, "text/plain", "run or csv not found");
    return;
  }
  const rows = await readRunCsvOrEmpty(state.csvPath);
  const row = rows.find((r) => r.image_id === imageId);
  if (!row) {
    send(res, 404, "text/plain", `image ${imageId} not in run`);
    return;
  }
  const opened = await openImageStream(row);
  if (!opened) {
    send(res, 410, "text/plain", "image bytes no longer available (local file pruned and Replicate URL expired)");
    return;
  }
  const topic = safeForFs(row.page_topic || row.cluster_id || "image", 60);
  const safeId = safeForFs(row.image_id, 60);
  const filename = `${topic}__${row.asset_type}__${safeId}.${opened.ext}`;
  const headers: Record<string, string> = {
    "content-type": IMAGE_CT[opened.ext] ?? "application/octet-stream",
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "private, max-age=0",
    "accept-ranges": "none",
  };
  if (opened.size != null) headers["content-length"] = String(opened.size);
  // Weak ETag from (mtime, size) — strong enough to detect changes
  // (regen overwrites both fields), cheap to compute. Pairs with
  // Last-Modified to enable a 304 Not Modified short-circuit when
  // the operator re-clicks the link.
  if (opened.localMtimeMs != null && opened.size != null) {
    const lastMod = new Date(opened.localMtimeMs).toUTCString();
    const etag = `W/"${opened.size.toString(16)}-${Math.floor(opened.localMtimeMs).toString(16)}"`;
    headers["last-modified"] = lastMod;
    headers["etag"] = etag;
    const ifNoneMatch = req.headers["if-none-match"];
    const ifModSince = req.headers["if-modified-since"];
    const matchesEtag = typeof ifNoneMatch === "string" && ifNoneMatch === etag;
    const notModified =
      typeof ifModSince === "string" &&
      !Number.isNaN(Date.parse(ifModSince)) &&
      opened.localMtimeMs <= Date.parse(ifModSince) + 999; // ±1s rounding
    if (matchesEtag || notModified) {
      // Close the stream we just opened — we won't read it.
      try { opened.stream.destroy(); } catch { /* */ }
      res.writeHead(304, headers);
      res.end();
      return;
    }
  }
  // HEAD just needs the headers — no body.
  if (req.method === "HEAD") {
    try { opened.stream.destroy(); } catch { /* */ }
    res.writeHead(200, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  opened.stream.pipe(res);
  opened.stream.on("error", () => { try { res.destroy(); } catch { /* */ } });
}

/**
 * Stream every completed image in a run as a single ZIP, organised
 * into per-cluster folders by topic. Uses archiver in "store" mode
 * (no compression) — images are already compressed, so deflate would
 * just burn CPU. Peak memory is tiny: archiver pipes entries straight
 * to the response, and each entry is itself a file/network stream.
 *
 * Cluster folder naming: `<safe-topic>__<short-cluster-id>` keeps
 * topics readable while guaranteeing uniqueness when two clusters
 * happen to share the same topic string.
 */
async function runDownloadZip(req: IncomingMessage, res: ServerResponse, runId: string) {
  let state = RUNS.get(runId) ?? null;
  if (!state) state = await tryReconstructRunFromDisk(runId);
  if (!state || !state.csvPath) {
    send(res, 404, "text/plain", "run or csv not found");
    return;
  }
  const rows = await readRunCsvOrEmpty(state.csvPath);
  const usable = rows.filter((r) => r.image_url_new || r.image_local_path);
  if (usable.length === 0) {
    send(res, 404, "text/plain", "no completed images in this run");
    return;
  }

  const zipName = `${safeForFs(state.client, 40)}-${state.id}.zip`;
  const headers: Record<string, string> = {
    "content-type": "application/zip",
    "content-disposition": `attachment; filename="${zipName}"`,
    "cache-control": "private, max-age=0",
    "accept-ranges": "none",
  };
  // HEAD: confirm the run is downloadable without streaming the body.
  if (req.method === "HEAD") {
    res.writeHead(200, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);

  // Store mode (level 0) — never recompress. Images already compressed.
  let archive: ReturnType<typeof archiver>;
  try {
    archive = archiver("zip", { zlib: { level: 0 }, store: true });
  } catch (err) {
    process.stderr.write(`zip: archiver init failed: ${(err as Error).message}\n`);
    try { res.destroy(); } catch { /* */ }
    return;
  }
  archive.on("warning", (err) => {
    process.stderr.write(`zip: warning ${err.message}\n`);
  });
  archive.on("error", (err) => {
    process.stderr.write(`zip: error ${err.message}\n`);
    try { res.destroy(); } catch { /* */ }
  });
  archive.pipe(res);
  res.on("close", () => { try { archive.abort(); } catch { /* */ } });

  // Group by cluster — same as the workspace publish view — so folders
  // are stable + we can write the manifest with the topic at the top.
  const byCluster = new Map<string, { topic: string; rows: CsvRowParsed[] }>();
  for (const r of usable) {
    const g = byCluster.get(r.cluster_id) ?? { topic: r.page_topic, rows: [] };
    g.rows.push(r);
    byCluster.set(r.cluster_id, g);
  }

  // Top-level README so the zip is self-describing.
  const readme = [
    `Run ${state.id}`,
    `Client: ${state.client}`,
    `Generated at: ${state.startedAt}`,
    `Total images: ${usable.length}`,
    `Clusters: ${byCluster.size}`,
    "",
    "Each subfolder is one cluster (topic). Files inside are named",
    "<asset_type>__<image_id>.<ext> and are the raw generated images",
    "with no recompression.",
    "",
    "manifest.csv at the zip root has every row from the run — image_id,",
    "asset_type, cluster_id, page_topic, prompt_used, etc. — so you can",
    "cross-reference back to the original page.",
  ].join("\n");
  archive.append(readme, { name: "README.txt" });

  // Include the run's CSV as manifest.csv — small (a few KB) and gives
  // the user every detail of the run (prompts, descriptions, ids).
  if (state.csvPath) {
    try {
      const stat = statSync(state.csvPath);
      if (stat.isFile()) {
        archive.file(state.csvPath, { name: "manifest.csv" });
      }
    } catch { /* CSV missing — skip silently */ }
  }

  try {
    for (const [clusterId, group] of byCluster) {
      const folder = `${safeForFs(group.topic || clusterId, 80)}__${clusterId.slice(0, 8)}`;
      for (const r of group.rows) {
        const opened = await openImageStream(r);
        if (!opened) {
          process.stderr.write(`zip: skip ${r.image_id} (no usable source)\n`);
          continue;
        }
        const safeId = safeForFs(r.image_id, 60);
        const entryName = `${folder}/${r.asset_type}__${safeId}.${opened.ext}`;
        archive.append(opened.stream, { name: entryName });
      }
    }
    await archive.finalize();
  } catch (err) {
    process.stderr.write(`zip: build failed: ${(err as Error).message}\n${(err as Error).stack ?? ""}\n`);
    try { archive.abort(); } catch { /* */ }
    try { res.destroy(); } catch { /* */ }
  }
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
// Upload-run pipeline — parallel to /regen. Operator picks images in
// the workspace exactly like for regen, clicks "Upload replacements →"
// instead of "Generate", and lands on a /runs/<id> page whose cards
// expose a drop-zone per image instead of a Replicate-generated
// preview. Apply pipeline is unchanged.
//
// Endpoints:
//   POST   /upload-run/start       — body: {client, page_type, items}.
//                                    Builds manifest + skeleton CSV.
//                                    Returns {run_id, url}.
//   POST   /runs/<id>/upload/<imgid>  — raw image bytes in body.
//                                       Validates, canonicalises via
//                                       sharp (auto-rotate, drop
//                                       EXIF, single-frame), writes
//                                       to volume, updates CSV +
//                                       sidecar.
//   DELETE /runs/<id>/upload/<imgid>  — clears the row.
// ────────────────────────────────────────────────────────────────────────
async function uploadRunStartHandler(req: IncomingMessage, res: ServerResponse) {
  type Body = {
    client?: string;
    page_type?: string;
    items?: Array<{ cluster_id?: string; image_ids?: string[] }>;
  };
  const body = (await readApplyBody(req)) as Body | null;
  if (!body || !body.client) return sendJson(res, 400, { error: "client required" });
  const items = Array.isArray(body.items) ? body.items : [];
  const clusterIds = new Set(items.map((i) => i.cluster_id ?? "").filter(Boolean));
  const imageIds = new Set(items.flatMap((i) => i.image_ids ?? []).filter(Boolean));
  if (clusterIds.size === 0 || imageIds.size === 0) {
    return sendJson(res, 400, { error: "items must include at least one cluster_id + image_id" });
  }
  const ptRaw = (body.page_type ?? "blog").split(",").map((s) => s.trim()).filter(Boolean);
  const allowed = new Set<string>(["blog", "service", "category"]);
  const pageTypes = ptRaw.filter((p) => allowed.has(p)) as ("blog" | "service" | "category")[];
  if (pageTypes.length === 0) pageTypes.push("blog");
  try {
    const { startUploadRun } = await import("./uploadRun.js");
    const result = await startUploadRun({
      client: body.client,
      pageType: pageTypes.length === 1 ? pageTypes[0]! : pageTypes,
      clusterIds,
      imageIds,
    });
    // Synthesise a RunState so /runs/<id> renders without waiting
    // for the manifest reconstruction round-trip.
    const state: RunState = {
      id: result.runId,
      client: body.client,
      args: ["(upload run)"],
      startedAt: new Date().toISOString(),
      log: ["(upload run — no subprocess)\n"],
      done: true,
      exitCode: 0,
      csvPath: result.csvPath,
      htmlPath: undefined,
      proc: { kill() { /* no-op */ } } as unknown as ChildProcess,
      listeners: new Set(),
      mode: "upload",
    };
    RUNS.set(result.runId, state);
    // Stamp the operator's email (from their bearer JWT) so the
    // recent-runs table can show "Run by" without holding any
    // server session state. Best-effort — upload runs without a
    // token still proceed and the column shows "—".
    void writeRunMeta(result.runId, {
      started_by_email: readOperatorEmail(req),
      started_by_set_at: new Date().toISOString(),
    });
    sendJson(res, 200, { run_id: result.runId, url: `/runs/${result.runId}`, row_count: result.rowCount });
  } catch (err) {
    sendJson(res, 500, { error: (err as Error).message });
  }
}

async function uploadRunImagePost(
  req: IncomingMessage,
  res: ServerResponse,
  runId: string,
  imageId: string,
) {
  let state = RUNS.get(runId) ?? null;
  if (!state) state = await tryReconstructRunFromDisk(runId);
  if (!state || !state.csvPath) return sendJson(res, 404, { error: `run ${runId} not found` });
  if (state.mode !== "upload") {
    return sendJson(res, 400, { error: `run ${runId} is a regen run, not an upload run — cannot accept dropped files` });
  }

  // Fast Content-Length pre-check — the client has set it on the
  // fetch, so reject oversize uploads before reading any bytes.
  const claimedLen = Number.parseInt(String(req.headers["content-length"] ?? "0"), 10);
  if (Number.isFinite(claimedLen) && claimedLen > 10 * 1024 * 1024) {
    return sendJson(res, 413, { error: `file too large (${(claimedLen / 1024 / 1024).toFixed(1)} MB; max 10 MB)` });
  }

  // Collect the body. We accept raw image bytes (no multipart) — the
  // client sends `fetch(url, { method: 'POST', body: file })` with
  // file being a File / Blob. Content-Type carries the claimed MIME
  // but we don't trust it; magic-byte sniff is the source of truth.
  const chunks: Buffer[] = [];
  let total = 0;
  let aborted = false;
  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > 10 * 1024 * 1024) {
        aborted = true;
        break;
      }
      chunks.push(buf);
    }
  } catch (err) {
    return sendJson(res, 500, { error: `upload stream failed: ${(err as Error).message}` });
  }
  if (aborted) {
    return sendJson(res, 413, { error: "file too large (>10 MB) — upload aborted mid-stream" });
  }
  if (total === 0) return sendJson(res, 400, { error: "empty upload (0 bytes)" });
  const raw = Buffer.concat(chunks, total);

  // The slot's expected aspect comes from the CSV row.
  const rows = await readRunCsvOrEmpty(state.csvPath);
  const row = rows.find((r) => r.image_id === imageId);
  if (!row) return sendJson(res, 404, { error: `image_id ${imageId} not in run CSV` });
  const expectedAspect = row.aspect_ratio || null;

  const {
    validateAndCanonicalise,
    writeUploadedImage,
    loadUploadState,
    saveUploadState,
    updateCsvRowAfterUpload,
  } = await import("./uploadRun.js");
  const v = await validateAndCanonicalise(raw, expectedAspect);
  if (!v.ok) return sendJson(res, v.status, { error: v.error });

  let finalAbs: string;
  try {
    finalAbs = await writeUploadedImage(runId, imageId, v.bytes, v.ext);
  } catch (err) {
    return sendJson(res, 500, { error: `failed to write file to volume: ${(err as Error).message}` });
  }

  // CSV + sidecar updates. CSV first because Apply reads it; sidecar
  // is best-effort metadata. If CSV write fails, roll back the file.
  try {
    await updateCsvRowAfterUpload(state.csvPath, imageId, {
      image_local_path: finalAbs,
      status: "ready",
      error: "",
    });
  } catch (err) {
    try { await (await import("./uploadRun.js")).removeUploadedImage(runId, imageId); } catch { /* */ }
    return sendJson(res, 500, { error: `failed to update CSV: ${(err as Error).message}` });
  }
  try {
    const state2 = await loadUploadState(runId);
    // Client URL-encodes the filename so non-Latin1 chars don't
    // trip setRequestHeader's ISO-8859-1 check. Try/catch on
    // decodeURIComponent in case the value isn't actually encoded.
    const rawOrigName = String(req.headers["x-original-filename"] ?? "").slice(0, 400);
    let origName = rawOrigName;
    try { origName = decodeURIComponent(rawOrigName); } catch { /* keep raw */ }
    origName = origName.slice(0, 200);
    state2.image_ids[imageId] = {
      path: path.relative(runOutDir(), finalAbs),
      size_bytes: v.bytes.length,
      mime: v.mime,
      width: v.width,
      height: v.height,
      aspect: v.aspect,
      sha256: v.sha256,
      original_name: origName,
      uploaded_at: new Date().toISOString(),
      aspect_warning: v.aspect_warning,
    };
    await saveUploadState(runId, state2);
  } catch (err) {
    process.stderr.write(`uploadRunImagePost: sidecar write failed for ${imageId}: ${(err as Error).message}\n`);
  }
  sendJson(res, 200, {
    ok: true,
    image_id: imageId,
    preview_url: `/runs/${runId}/preview/${encodeURIComponent(imageId)}?t=${Date.now()}`,
    width: v.width,
    height: v.height,
    aspect: v.aspect,
    mime: v.mime,
    size_bytes: v.bytes.length,
    sha256: v.sha256,
    aspect_warning: v.aspect_warning,
  });
}

async function uploadRunImageDelete(
  _req: IncomingMessage,
  res: ServerResponse,
  runId: string,
  imageId: string,
) {
  let state = RUNS.get(runId) ?? null;
  if (!state) state = await tryReconstructRunFromDisk(runId);
  if (!state || !state.csvPath) return sendJson(res, 404, { error: `run ${runId} not found` });
  if (state.mode !== "upload") return sendJson(res, 400, { error: "not an upload run" });
  const { removeUploadedImage, loadUploadState, saveUploadState, updateCsvRowAfterUpload } = await import("./uploadRun.js");
  try {
    await removeUploadedImage(runId, imageId);
    await updateCsvRowAfterUpload(state.csvPath, imageId, {
      image_local_path: "",
      status: "pending",
      error: "",
    });
    const s = await loadUploadState(runId);
    if (s.image_ids[imageId]) {
      delete s.image_ids[imageId];
      await saveUploadState(runId, s);
    }
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 500, { error: (err as Error).message });
  }
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

      // Dedicated health endpoint — Railway's deploy probe hits this
      // path. Returns 200 immediately with no DB / disk I/O so a cold
      // container is reported healthy the moment the listener is up.
      // The home page handler does a real DB round trip on every
      // render; using "/" as the healthcheck means a slow first
      // request can time out the probe → SIGTERM → CREATE_CONTAINER
      // failure. /healthz sidesteps that entirely.
      if (method === "GET" && (p === "/healthz" || p === "/_health")) {
        return sendJson(res, 200, { ok: true });
      }
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
      const wsTokenMatch = /^\/workspace\/([^/]+)\/token$/.exec(p);
      if (method === "POST" && wsTokenMatch && wsTokenMatch[1]) {
        return await saveTokenHandler(req, res, decodeURIComponent(wsTokenMatch[1]));
      }
      const wsTokenExtractMatch = /^\/workspace\/([^/]+)\/token\/extract$/.exec(p);
      if (method === "POST" && wsTokenExtractMatch && wsTokenExtractMatch[1]) {
        return await extractTokenHandler(res, decodeURIComponent(wsTokenExtractMatch[1]));
      }
      const wsTokenStatusMatch = /^\/workspace\/([^/]+)\/token\/status$/.exec(p);
      if (method === "GET" && wsTokenStatusMatch && wsTokenStatusMatch[1]) {
        return await tokenStatusHandler(res, decodeURIComponent(wsTokenStatusMatch[1]));
      }
      const wsMatch = /^\/workspace\/([^/]+)\/?$/.exec(p);
      if (method === "GET" && wsMatch && wsMatch[1]) {
        // `?selected=blog,service,category` is now the canonical
        // multi-select param. Legacy `?page_type=service` (singular)
        // still resolves — we treat it as a single-pill selection.
        const ptRaw = url.searchParams.get("page_type");
        const legacyPt: PageType | null =
          ptRaw === "service" || ptRaw === "category" || ptRaw === "blog" ? ptRaw : null;
        const selectedRaw = url.searchParams.get("selected") ?? "";
        const selected = new Set<PageType>();
        for (const t of selectedRaw.split(",").map((s) => s.trim())) {
          if (t === "blog" || t === "service" || t === "category") selected.add(t);
        }
        if (selected.size === 0 && legacyPt) selected.add(legacyPt);
        return await workspacePage(
          res,
          decodeURIComponent(wsMatch[1]),
          legacyPt ?? "blog",
          selected.size > 0 ? selected : undefined,
        );
      }

      if (method === "POST" && p === "/regen") return await regenPostHandler(req, res);
      if (method === "POST" && p === "/api/regen-one") return await regenOneHandler(req, res);
      // Upload-run pipeline. Strictly additive — never touches /regen.
      if (method === "POST" && p === "/upload-run/start") return await uploadRunStartHandler(req, res);
      const uploadMatch = /^\/runs\/([a-f0-9]+)\/upload\/(.+)$/.exec(p);
      if (uploadMatch && uploadMatch[1] && uploadMatch[2]) {
        if (method === "POST")   return await uploadRunImagePost(req, res, uploadMatch[1], decodeURIComponent(uploadMatch[2]));
        if (method === "DELETE") return await uploadRunImageDelete(req, res, uploadMatch[1], decodeURIComponent(uploadMatch[2]));
      }
      // Pipeline endpoints. /api/apply/* kept as back-compat aliases
      // for the existing client JS; /api/repoint/* are the canonical
      // names. All run the upload→repoint pipeline now.
      if (method === "POST" && (p === "/api/apply-one" || p === "/api/apply/image" || p === "/api/repoint/image"))
        return await applyImageHandler(req, res);
      if (method === "POST" && (p === "/api/apply/cluster" || p === "/api/repoint/cluster"))
        return await applyClusterHandler(req, res);
      if (method === "POST" && (p === "/api/apply/run" || p === "/api/repoint/run"))
        return await applyRunHandler(req, res);
      if (method === "POST" && p === "/api/revert/cluster") return await revertClusterHandler(req, res);
      if (method === "POST" && p === "/api/revert/run")     return await revertRunHandler(req, res);
      if (method === "POST" && p === "/api/token")        return await tokenSetHandler(req, res);
      if (method === "POST" && p === "/api/token/clear")  return await tokenClearHandler(req, res);
      if (method === "GET"  && p === "/api/token/status") return sendJson(res, 200, { status: tokenStatusFromHeader(req) });
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
      // Returns the current system+user template text for each prompt
      // group ("cover" | "infographic" | "page" | "generic"), so the
      // workspace's confirm-and-edit modal can pre-populate textareas
      // with what would otherwise run.
      if (method === "GET" && p === "/api/prompts") {
        const { defaultTemplatesForGroup, promptGroupLabel } = await import("./buildPrompt.js");
        const groups = ["cover", "infographic", "page", "generic"] as const;
        const out = groups.map((g) => ({
          group: g,
          label: promptGroupLabel(g),
          ...defaultTemplatesForGroup(g),
        }));
        return sendJson(res, 200, { groups: out });
      }
      if (method === "GET" && p === "/flows") return await flowsPage(res);
      if (method === "GET" && p === "/runs") return runListPage(res);
      const runZipMatch = /^\/runs\/([a-f0-9]+)\/download\.zip$/.exec(p);
      if ((method === "GET" || method === "HEAD") && runZipMatch && runZipMatch[1]) {
        return await runDownloadZip(req, res, runZipMatch[1]);
      }
      const runOneMatch = /^\/runs\/([a-f0-9]+)\/download\/(.+)$/.exec(p);
      if ((method === "GET" || method === "HEAD") && runOneMatch && runOneMatch[1] && runOneMatch[2]) {
        return await runDownloadOne(req, res, runOneMatch[1], decodeURIComponent(runOneMatch[2]));
      }
      const runPreviewMatch = /^\/runs\/([a-f0-9]+)\/preview\/(.+)$/.exec(p);
      if ((method === "GET" || method === "HEAD") && runPreviewMatch && runPreviewMatch[1] && runPreviewMatch[2]) {
        return await runPreviewOne(req, res, runPreviewMatch[1], decodeURIComponent(runPreviewMatch[2]));
      }
      const runMatch = /^\/runs\/([a-f0-9]+)(\/events)?$/.exec(p);
      if (method === "GET" && runMatch) {
        const [, id, suffix] = runMatch;
        if (!id) return send(res, 404, "text/plain", "not found");
        if (suffix === "/events") return runEvents(res, id);
        // "?stage=prepare" renders the upload-onboarding view for an
        // upload-mode run: dropzones only, no Apply buttons, with a
        // "Continue to Apply" CTA in the bottom bar. Default stage is
        // the existing Apply view.
        const stage = url.searchParams.get("stage") === "prepare" ? "prepare" : "apply";
        return runPage(res, id, stage);
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
      const msg = (err as Error).message;
      process.stderr.write(`server: handler error: ${msg}\n${(err as Error).stack ?? ""}\n`);
      // If we already started streaming a response, we can't write a
      // 500 status — just destroy the socket and let the client see
      // the truncation. (The detailed error is in the stderr above.)
      if (res.headersSent) {
        try { res.destroy(); } catch { /* */ }
      } else {
        send(res, 500, "text/plain", `error: ${msg}`);
      }
    }
  });

  // Bind to 0.0.0.0 explicitly. Default Node `listen(port)` picks
  // ::  (all IPv6) on dual-stack systems — Railway / Fly / Render
  // health checks all hit IPv4, and a container with constrained
  // IPv6 will appear unreachable, get SIGTERM'd, and the deploy
  // marked failed at CREATE_CONTAINER. 0.0.0.0 is the portable
  // choice for any PaaS.
  const host = process.env.HOST ?? "0.0.0.0";
  server.listen(port, host, () => {
    process.stdout.write(`web: listening on http://${host}:${port}\n`);
    // Surface the token-store layout so operators can confirm at boot
    // whether extracts will survive redeploys (operator dir ≠ bundled
    // dir + the operator dir is on a persistent volume).
    const tsl = tokenStoreLayout();
    if (tsl.layered) {
      process.stdout.write(
        `web: graphic_token store = bundled:${tsl.bundled} + operator:${tsl.operator}\n`,
      );
    } else {
      process.stdout.write(
        `web: graphic_token store = ${tsl.bundled} (single layer — set GRAPHIC_TOKEN_DIR for persistence)\n`,
      );
    }
    // Warm the featured-client cache so the very first home page render
    // doesn't pay the projects.id round-trip cost.
    loadClientPickerEntries().catch(() => { /* ignore — env may not be ready yet */ });

    // Retention sweep — bounded disk on Railway. Run once at boot
    // (clears anything that aged out while we were offline) and then
    // every 30 minutes. The sweep is best-effort and never blocks
    // requests.
    const cfg = loadRetentionConfig();
    process.stdout.write(
      `web: retention = keep last ${cfg.maxRunsKept} runs OR last ${cfg.retentionHours}h\n`,
    );
    const runSweep = () => {
      sweepRunRetention(cfg)
        .then((r) => {
          if (r.evicted > 0) {
            process.stdout.write(
              `retention: evicted ${r.evicted}/${r.scanned} runs · freed ${(r.bytesFreed / 1024 / 1024).toFixed(1)} MB\n`,
            );
          }
        })
        .catch((err) => {
          process.stderr.write(`retention: sweep failed: ${(err as Error).message}\n`);
        });
    };
    runSweep();
    setInterval(runSweep, 30 * 60 * 1000).unref();
  });

  process.on("SIGINT", async () => {
    await closePool();
    server.close(() => process.exit(0));
  });
}
