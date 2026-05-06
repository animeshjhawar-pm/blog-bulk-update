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
  rows: CsvRow[];
}

export async function writeHtmlReport(params: HtmlReportParams): Promise<void> {
  const { rows } = params;
  const totals = {
    ok: rows.filter((r) => r.status === "completed").length,
    failed: rows.filter((r) => r.status === "failed").length,
    dryRun: rows.filter((r) => r.status === "dry-run").length,
  };
  const csvFile = path.basename(params.csvPath);

  const tableRows = rows
    .map((r) => {
      const preview = r.image_url_new
        ? `<img src="${escapeAttr(r.image_url_new)}" alt="${escapeAttr(r.image_id)}" loading="lazy">`
        : `<div class="empty">${escapeHtml(r.status)}</div>`;
      const localLink = r.image_local_path
        ? `<a href="${escapeAttr("file://" + r.image_local_path)}">download local</a>`
        : "";
      const newUrlLink = r.image_url_new
        ? `<a href="${escapeAttr(r.image_url_new)}" target="_blank" rel="noopener">open new</a>`
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
    ${r.image_url_new ? `<button class="copy" data-copy="${escapeAttr(r.image_url_new)}">copy url</button>` : ""}
    ${newUrlLink}
    ${localLink}
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
