import { promises as fs } from "node:fs";
import path from "node:path";
import type { CsvRow } from "./csv.js";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export interface HtmlReportParams {
  htmlPath: string;
  csvPath: string;
  clientSlug: string;
  clientName: string;
  projectId: string;
  startedAt: string;
  rows: readonly Partial<CsvRow>[];
  /**
   * The runId this HTML report belongs to. When set, previews and
   * downloads route through /runs/<runId>/preview/<image_id> and
   * /runs/<runId>/download/<image_id> — our server endpoints — so
   * the browser NEVER hits the raw provider URL. Critical for the
   * fal.ai fallback path, whose fal.media URLs return a sandbox CSP
   * that blocks direct browser display; the same fix is safe for
   * Replicate URLs (which also expire after ~1h).
   */
  runId?: string;
}

export async function writeHtmlReport(params: HtmlReportParams): Promise<void> {
  const { rows } = params;
  const totals = {
    ok: rows.filter((r) => r.status === "completed").length,
    failed: rows.filter((r) => r.status === "failed").length,
    dryRun: rows.filter((r) => r.status === "dry-run").length,
  };
  const csvFile = path.basename(params.csvPath);

  // Route every image URL through our server. Two reasons:
  //   1. fal.media (fallback path) returns a `sandbox` CSP that
  //      blocks direct browser display — <img src=fal.media/…> would
  //      render as a broken image or blank frame depending on browser.
  //   2. Replicate signed URLs expire ~1h after generation, so opening
  //      an old report would hit a 403 on every image.
  // Our /preview/ endpoint streams the local rehost'd file (or
  // server-side fetches remote when the local copy has been pruned),
  // so the browser sees regular image bytes with no CSP hostility and
  // no auth expiry.
  const previewSrc = (imageId: string): string =>
    params.runId ? `/runs/${encodeURIComponent(params.runId)}/preview/${encodeURIComponent(imageId)}` : "";
  const downloadHref = (imageId: string): string =>
    params.runId ? `/runs/${encodeURIComponent(params.runId)}/download/${encodeURIComponent(imageId)}` : "";

  const tableRows = rows
    .map((raw) => {
      // Coerce to a defined-string view — CsvRow is now Partial to
      // accommodate call-sites that predate later columns; html
      // doesn't care about the new fields, so default missing ones to "".
      const r = {
        image_id: raw.image_id ?? "",
        asset_type: raw.asset_type ?? "",
        cluster_id: raw.cluster_id ?? "",
        page_topic: raw.page_topic ?? "",
        image_url_new: raw.image_url_new ?? "",
        image_local_path: raw.image_local_path ?? "",
        description_used: raw.description_used ?? "",
        aspect_ratio: raw.aspect_ratio ?? "",
        status: raw.status ?? "",
        error: raw.error ?? "",
      };
      const hasImage = Boolean(r.image_url_new || r.image_local_path);
      const preview = hasImage && params.runId
        ? `<img src="${escapeAttr(previewSrc(r.image_id))}" alt="${escapeAttr(r.image_id)}" loading="lazy">`
        : hasImage
          ? `<div class="empty">image (no runId — open the run page in the workspace)</div>`
          : `<div class="empty">${escapeHtml(r.status)}</div>`;
      const openLink = hasImage && params.runId
        ? `<a href="${escapeAttr(previewSrc(r.image_id))}" target="_blank" rel="noopener">open new</a>`
        : "";
      const downloadLink = hasImage && params.runId
        ? `<a href="${escapeAttr(downloadHref(r.image_id))}" download>download</a>`
        : "";
      const errorCell = r.error
        ? `<div class="err">${escapeHtml(truncate(r.error, 240))}</div>`
        : "";

      return `
<tr data-status="${escapeAttr(r.status)}" data-asset="${escapeAttr(r.asset_type)}">
  <td class="id">
    <code>${escapeHtml(r.image_id)}</code>
    <button class="copy" data-copy="${escapeAttr(r.image_id)}">copy</button>
  </td>
  <td class="asset">${escapeHtml(r.asset_type)}<div class="ar">${escapeHtml(r.aspect_ratio)}</div></td>
  <td class="cluster">
    <div class="topic">${escapeHtml(truncate(r.page_topic, 90))}</div>
    <code class="cid">${escapeHtml(r.cluster_id)}</code>
  </td>
  <td class="img">${preview}</td>
  <td class="desc">${escapeHtml(truncate(r.description_used, 320))}</td>
  <td class="status"><span class="pill pill-${escapeAttr(r.status)}">${escapeHtml(r.status)}</span>${errorCell}</td>
  <td class="actions">
    ${openLink}
    ${downloadLink}
  </td>
</tr>`;
    })
    .join("");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>regen — ${escapeHtml(params.clientSlug)} — ${escapeHtml(params.startedAt)}</title>
<style>
  body { font: 13px/1.45 -apple-system, system-ui, Segoe UI, sans-serif; margin: 24px; color: #1a1a1a; background: #fafafa; }
  header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid #e2e2e2; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .meta { color: #555; font-size: 12px; }
  .totals { display: flex; gap: 12px; }
  .pill { padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
  .pill-completed { background: #d1fae5; color: #065f46; }
  .pill-failed { background: #fee2e2; color: #991b1b; }
  .pill-dry-run { background: #e0e7ff; color: #3730a3; }
  table { width: 100%; border-collapse: collapse; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
  th, td { padding: 10px 12px; vertical-align: top; border-bottom: 1px solid #eee; text-align: left; }
  th { background: #f3f4f6; position: sticky; top: 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #555; }
  td.id code, td.cluster code.cid { font-size: 11px; background: #f3f4f6; padding: 2px 6px; border-radius: 3px; word-break: break-all; }
  td.id { width: 240px; }
  td.asset { width: 90px; }
  td.asset .ar { color: #888; font-size: 11px; }
  td.cluster { width: 220px; }
  td.cluster .topic { font-weight: 500; margin-bottom: 4px; }
  td.img { width: 340px; }
  td.img img { max-width: 320px; max-height: 200px; display: block; border-radius: 4px; border: 1px solid #e2e2e2; }
  td.img .empty { color: #999; font-style: italic; padding: 24px 0; }
  td.desc { color: #555; }
  td.status { width: 110px; }
  td.status .err { font-size: 11px; color: #991b1b; margin-top: 6px; word-break: break-word; }
  td.actions { width: 160px; font-size: 12px; }
  td.actions button, td.actions a { display: block; margin-bottom: 4px; }
  button.copy { font: inherit; background: #fff; border: 1px solid #d1d5db; border-radius: 3px; padding: 2px 8px; cursor: pointer; }
  button.copy:hover { background: #f3f4f6; }
  button.copy.copied { background: #d1fae5; border-color: #065f46; }
  footer { margin-top: 16px; font-size: 12px; color: #555; }
  footer a { color: #2563eb; }
</style>
</head>
<body>
<header>
  <div>
    <h1>${escapeHtml(params.clientName)} <span style="color:#888;font-weight:400">/ ${escapeHtml(params.clientSlug)}</span></h1>
    <div class="meta">
      project_id <code>${escapeHtml(params.projectId)}</code> · started ${escapeHtml(params.startedAt)} · ${rows.length} images
    </div>
  </div>
  <div class="totals">
    <span class="pill pill-completed">${totals.ok} completed</span>
    <span class="pill pill-failed">${totals.failed} failed</span>
    <span class="pill pill-dry-run">${totals.dryRun} dry-run</span>
  </div>
</header>
<table>
  <thead>
    <tr>
      <th>image_id</th>
      <th>asset</th>
      <th>cluster / topic</th>
      <th>new image</th>
      <th>description</th>
      <th>status</th>
      <th>actions</th>
    </tr>
  </thead>
  <tbody>
${tableRows}
  </tbody>
</table>
<footer>
  <a href="./${escapeAttr(csvFile)}" download>Download CSV (${escapeHtml(csvFile)})</a>
</footer>
<script>
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button.copy');
  if (!btn) return;
  const value = btn.getAttribute('data-copy') || '';
  navigator.clipboard.writeText(value).then(() => {
    btn.classList.add('copied');
    const prev = btn.textContent;
    btn.textContent = 'copied!';
    setTimeout(() => { btn.classList.remove('copied'); btn.textContent = prev; }, 1100);
  });
});
</script>
</body>
</html>
`;

  await fs.writeFile(params.htmlPath, html, "utf8");
}
