import { promises as fs } from "node:fs";
import path from "node:path";
import { loadEnv } from "./env.js";
import {
  closePool,
  listPublishedBlogClusters,
  lookupProjectById,
  type ProjectRow,
} from "./db.js";
import { resolveGraphicToken, type TokenSource } from "./extractToken.js";
import { loadBrandGuidelines } from "./tokens.js";
import { buildImagePrompt } from "./buildPrompt.js";
import { generate, type Provider } from "./generate.js";
import { downloadImage } from "./rehost.js";
import { openCsv, type CsvRow, type CsvWriter } from "./csv.js";
import { writeHtmlReport } from "./html.js";
import { makeLimiter } from "./concurrency.js";
import {
  collectImageRecords,
  type AssetType,
  type ImageRecord,
} from "./pageInfo.js";
import { findClient } from "./clients.js";

export interface RegenOptions {
  client: string;
  dryRun: boolean;
  useSavedToken: boolean;
  assetTypes?: Set<AssetType>;
  clusterIds?: Set<string>;
  /** When set, only records whose `imageId` is in the set are regenerated. */
  imageIds?: Set<string>;
  provider?: Provider;
  concurrency: number;
}

function pickLogoUrl(project: ProjectRow): string | null {
  const lu = project.logo_urls as Record<string, unknown> | null;
  if (!lu || typeof lu !== "object") return null;
  for (const k of ["primary_logo", "logo", "primaryLogo"]) {
    const v = lu[k];
    if (typeof v === "string" && v.startsWith("http")) return v;
  }
  for (const v of Object.values(lu)) {
    if (typeof v === "string" && v.startsWith("http")) return v;
  }
  return null;
}

function utcStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "Z");
}

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 8) : id;
}

function buildBaseRow(args: {
  record: ImageRecord;
  project: ProjectRow;
  slug: string;
  generatedAt: string;
}): Pick<
  CsvRow,
  | "image_id"
  | "asset_type"
  | "cluster_id"
  | "page_topic"
  | "description_used"
  | "aspect_ratio"
  | "generated_at_utc"
  | "client_slug"
  | "project_id"
> {
  return {
    image_id: args.record.imageId,
    asset_type: args.record.asset,
    cluster_id: args.record.cluster.id,
    page_topic: args.record.cluster.topic ?? "",
    description_used: args.record.description,
    aspect_ratio: args.record.aspectRatio,
    generated_at_utc: args.generatedAt,
    client_slug: args.slug,
    project_id: args.project.id,
  };
}

interface RowResult {
  row: CsvRow;
  status: "completed" | "failed" | "dry-run";
}

function mergeBusinessContext(raw: unknown, brandGuidelines: string | null): unknown {
  if (!brandGuidelines) return raw;
  const base =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : { source: raw };
  return { ...base, client_brand_guidelines: brandGuidelines };
}

async function processOne(args: {
  record: ImageRecord;
  project: ProjectRow;
  graphicToken: unknown;
  brandGuidelines: string | null;
  logoUrl: string | null;
  options: RegenOptions;
  rowNum: number;
  totalRows: number;
  slug: string;
}): Promise<RowResult> {
  const { record, project, graphicToken, brandGuidelines, logoUrl, options, rowNum, totalRows, slug } = args;
  const generatedAt = new Date().toISOString();
  const base = buildBaseRow({ record, project, slug, generatedAt });

  let promptUsed = "";
  try {
    const built = await buildImagePrompt({
      asset: record.asset,
      imageDescription: record.description,
      businessContext: mergeBusinessContext(project.additional_info, brandGuidelines),
      companyInfo: project.company_info,
      graphicToken,
      clientHomepageUrl: project.url ?? "",
      projectId: project.id,
    });
    promptUsed = built.finalPrompt;

    if (options.dryRun) {
      process.stderr.write(
        `[${rowNum}/${totalRows}] cluster=${shortId(record.cluster.id)} asset=${record.asset} id=${record.imageId} status=dry-run\n`,
      );
      return {
        status: "dry-run",
        row: {
          ...base,
          prompt_used: promptUsed,
          image_url_new: "",
          image_local_path: "",
          status: "dry-run",
          error: "",
        },
      };
    }

    const imageInput = logoUrl ? [logoUrl] : [];
    const gen = await generate({
      prompt: promptUsed,
      aspectRatio: record.aspectRatio,
      imageInput,
      provider: options.provider,
    });

    const localPath = await downloadImage({
      url: gen.imageUrl,
      slug,
      imageId: record.imageId,
    });

    process.stderr.write(
      `[${rowNum}/${totalRows}] cluster=${shortId(record.cluster.id)} asset=${record.asset} id=${record.imageId} status=completed\n`,
    );

    return {
      status: "completed",
      row: {
        ...base,
        prompt_used: promptUsed,
        image_url_new: gen.imageUrl,
        image_local_path: localPath,
        status: "completed",
        error: "",
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[${rowNum}/${totalRows}] cluster=${shortId(record.cluster.id)} asset=${record.asset} id=${record.imageId} status=failed error=${message.slice(0, 200)}\n`,
    );
    return {
      status: "failed",
      row: {
        ...base,
        prompt_used: promptUsed,
        image_url_new: "",
        image_local_path: "",
        status: "failed",
        error: message,
      },
    };
  }
}

export async function runRegen(options: RegenOptions): Promise<void> {
  loadEnv();
  const slug = options.client;

  const entry = findClient(slug);
  if (!entry) {
    process.stderr.write(
      `error: '${slug}' is not in the hardcoded CLIENTS allow-list (src/clients.ts)\n`,
    );
    await closePool();
    process.exit(2);
  }

  const project = await lookupProjectById(entry.projectId);
  if (!project) {
    process.stderr.write(
      `error: project ${entry.projectId} (slug=${slug}) not found in DB\n`,
    );
    await closePool();
    process.exit(2);
  }
  process.stderr.write(`regen: client='${project.name ?? slug}' project_id=${project.id}\n`);

  const brandGuidelines = await loadBrandGuidelines(slug);
  if (brandGuidelines) {
    process.stderr.write(
      `regen: brand_guidelines=loaded (${brandGuidelines.length} chars; injected into business_context.client_brand_guidelines for every prompt)\n`,
    );
  }

  let graphicToken: unknown;
  let tokenSource: TokenSource;
  try {
    const resolved = await resolveGraphicToken({
      slug,
      url: project.url ?? "",
      projectId: project.id,
      useSavedToken: options.useSavedToken,
    });
    graphicToken = resolved.token;
    tokenSource = resolved.source;
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    await closePool();
    process.exit(3);
  }

  const clusters = await listPublishedBlogClusters(project.id);
  process.stderr.write(`regen: ${clusters.length} published blog clusters\n`);

  const records = await collectImageRecords(clusters, {
    assetTypes: options.assetTypes,
    clusterIds: options.clusterIds,
    imageIds: options.imageIds,
    stagingSubdomain: project.staging_subdomain,
  });
  process.stderr.write(
    `regen: ${records.length} image records to process` +
      (options.imageIds ? ` (--image-ids filter: ${options.imageIds.size})` : "") +
      "\n",
  );

  if (records.length === 0) {
    process.stderr.write(`regen: nothing to do — exiting\n`);
    await closePool();
    return;
  }

  const stamp = utcStamp();
  const outDir = path.resolve(process.cwd(), "out");
  await fs.mkdir(outDir, { recursive: true });

  const csvPath = path.join(outDir, `${slug}-${stamp}.csv`);
  const htmlPath = csvPath.replace(/\.csv$/, ".html");
  const manifestPath = path.join(outDir, `manifest-${stamp}.json`);
  const csv: CsvWriter = await openCsv(csvPath);
  process.stderr.write(`regen: writing ${csvPath}\n`);

  const startedAt = new Date().toISOString();
  const baseManifest = {
    client: slug,
    client_name: project.name,
    project_id: project.id,
    asset_types: options.assetTypes ? [...options.assetTypes] : null,
    cluster_ids: options.clusterIds ? [...options.clusterIds] : null,
    image_ids: options.imageIds ? [...options.imageIds] : null,
    dry_run: options.dryRun,
    use_saved_token: options.useSavedToken,
    token_source: tokenSource,
    provider: options.provider ?? loadEnv().IMAGE_PROVIDER,
    concurrency: options.concurrency,
    started_at: startedAt,
    csv: csvPath,
    html: htmlPath,
    total_rows: records.length,
  };
  await fs.writeFile(manifestPath, JSON.stringify(baseManifest, null, 2) + "\n", "utf8");

  const logoUrl = pickLogoUrl(project);
  if (!logoUrl) {
    process.stderr.write(
      `regen: warning — no primary_logo URL found in projects.logo_urls; image_input will be empty\n`,
    );
  }

  const limit = makeLimiter(options.concurrency);
  const total = records.length;

  const allRows: CsvRow[] = new Array(total);
  const tasks = records.map((record, i) =>
    limit(async () => {
      const result = await processOne({
        record,
        project,
        graphicToken,
        brandGuidelines,
        logoUrl,
        options,
        rowNum: i + 1,
        totalRows: total,
        slug,
      });
      allRows[i] = result.row;
      await csv.write(result.row);
    }),
  );

  await Promise.all(tasks);
  await csv.close();

  const summary = {
    ok: allRows.filter((r) => r.status === "completed").length,
    failed: allRows.filter((r) => r.status === "failed").length,
    dry_run: allRows.filter((r) => r.status === "dry-run").length,
  };
  await fs.writeFile(
    manifestPath,
    JSON.stringify(
      { ...baseManifest, finished_at: new Date().toISOString(), summary },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  await writeHtmlReport({
    htmlPath,
    csvPath,
    clientSlug: slug,
    clientName: project.name ?? slug,
    projectId: project.id,
    startedAt,
    rows: allRows,
  });

  await closePool();
  process.stderr.write(
    `regen: done — ${summary.ok} ok, ${summary.failed} failed, ${summary.dry_run} dry-run\n`,
  );
  process.stderr.write(`regen: csv=${csvPath}\nregen: html=${htmlPath}\n`);
}
