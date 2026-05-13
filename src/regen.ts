import { promises as fs } from "node:fs";
import path from "node:path";
import { loadEnv } from "./env.js";
import {
  closePool,
  listPublishedClusters,
  lookupProjectById,
  type ProjectRow,
  type PageType,
} from "./db.js";
import { resolveGraphicToken, type TokenSource } from "./extractToken.js";
import { loadBrandGuidelines, loadProjectOverrides } from "./tokens.js";
import {
  buildImagePrompt,
  applyAdditionalInstructions,
  stripAdditionalInstructions,
  extractAdditionalInstructions,
} from "./buildPrompt.js";
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
  /** Defaults to "blog". Accepts a single page_type or an array of
   * them — when an array is passed, listPublishedClusters merges all
   * matching clusters into one run. */
  pageType?: PageType | PageType[];
  /** When set, persisted to the manifest so the web UI can link
   * `/runs/<id>` back to this run after a server restart. */
  runId?: string;
  provider?: Provider;
  concurrency: number;
  /**
   * Mock mode: skip Firecrawl + Portkey + image generation entirely.
   * Each row gets a synthetic prompt and a picsum.photos URL keyed by
   * image_id so the run page populates in <5s with realistic-looking
   * images for the publish-flow UX. Used to validate the platform
   * without spending API budget.
   */
  mock?: boolean;
  /**
   * When set, every record skips the buildImagePrompt (Portkey) call
   * and uses this literal text as the image-gen prompt. The web UI's
   * single-image Regenerate button uses this to reuse the parent
   * run's prompt — saves ~5–10s per regeneration.
   */
  promptOverride?: string;
  /**
   * Free-text addendum merged into the per-record top-priority
   * brand-directives block at generation time. Used by the web UI's
   * "Regenerate (custom instructions)" flow — the operator types a
   * one-off tweak ("make it warmer", "remove the people") and it
   * rides along ONLY for this run. Never mutates the saved
   * graphic_token. Combines with any existing additional_instructions
   * from the token (both go into the same block).
   */
  extraInstructions?: string;
  /**
   * When set, the generation call first polls Replicate for THIS
   * prediction id. If it has succeeded since the prior attempt, we
   * use its URL with zero new spend — recovers predictions that
   * completed after the parent run's 280s polling budget. Single-
   * image regen sets this from the parent CSV row's prediction_id.
   */
  resumePredictionId?: string;
}

function pickLogoUrl(project: ProjectRow, override: string | null): string | null {
  // Operator-edited override always wins.
  if (override && override.startsWith("http")) return override;

  // Canonical brand logo (the asset image-gen prompts should use as
  // image_input) is at the well-known per-staging path
  //   https://file-host.link/website/<staging>/assets/logo/logo.webp
  // We prefer this over the timestamped favicon-style entries in
  // projects.logo_urls because the latter are usually 16×16 favicon
  // PNGs that produce poor results when fed to Replicate as a
  // reference image.
  if (project.staging_subdomain) {
    return `https://file-host.link/website/${project.staging_subdomain}/assets/logo/logo.webp`;
  }

  // Last-resort fallback: anything in projects.logo_urls.
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
  | "previous_image_url"
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
    previous_image_url: args.record.previewUrl ?? "",
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

/**
 * Build a deterministic picsum.photos URL keyed by image_id so the same
 * record always renders the same fake new image. Aspect ratio is read
 * from the record so cover (1:1) renders square and infographic (16:9)
 * renders widescreen.
 */
function mockImageUrl(record: ImageRecord): string {
  const [w = 16, h = 9] = (record.aspectRatio.split(":").map(Number) as [number, number?]);
  const W = 800;
  const H = Math.max(1, Math.round((W * (h ?? 9)) / (w || 16)));
  const seed = record.imageId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 40) || "regen";
  return `https://picsum.photos/seed/${seed}/${W}/${H}`;
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

  // Mock mode: skip every external call. Used to validate the publish
  // flow UX without burning Portkey / Replicate budget.
  if (options.mock) {
    const mockUrl = mockImageUrl(record);
    process.stderr.write(
      `[${rowNum}/${totalRows}] cluster=${shortId(record.cluster.id)} asset=${record.asset} id=${record.imageId} status=mock url=${mockUrl}\n`,
    );
    return {
      status: "completed",
      row: {
        ...base,
        prompt_used: `[mock] synthetic ${record.asset} prompt for ${record.imageId}\n\nDescription: ${record.description.slice(0, 200)}`,
        image_url_new: mockUrl,
        image_local_path: "",
        status: "completed",
        error: "",
        prediction_id: "",
      },
    };
  }

  // Compose the "directives" that prefix the final prompt. Saved
  // graphic_token additional_instructions + this run's one-off extra
  // instructions (web UI's "Regenerate with custom instructions"
  // flow) are concatenated into a single block. Extras come AFTER
  // saved so they read as the most-specific override.
  const savedDirectives = extractAdditionalInstructions(graphicToken);
  const extras = (options.extraInstructions ?? "").trim();
  const mergedDirectives = [savedDirectives, extras]
    .filter((s): s is string => !!s && s.length > 0)
    .join("\n\n")
    || null;

  let promptUsed = "";
  try {
    if (options.promptOverride && options.promptOverride.trim().length > 0) {
      // Skip Portkey: reuse the parent run's prompt. Used by the
      // web UI's single-image Regenerate flow to shave the
      // prompt-building round trip.
      //
      // Brand-directives twist: the parent prompt has the directives
      // that were active AT THE TIME of the original generation. If
      // the operator has since updated additional_instructions, OR
      // passed one-off extras for this regen, those stale directives
      // would ride along. Strip + re-apply the MERGED current ones.
      const stripped = stripAdditionalInstructions(options.promptOverride);
      promptUsed = applyAdditionalInstructions(stripped, mergedDirectives);
      process.stderr.write(
        `[${rowNum}/${totalRows}] cluster=${shortId(record.cluster.id)} asset=${record.asset} id=${record.imageId} prompt=override${mergedDirectives ? `+directives${extras ? "+extras" : ""}` : ""}\n`,
      );
    } else {
      const built = await buildImagePrompt({
        asset: record.asset,
        imageDescription: record.description,
        businessContext: mergeBusinessContext(project.additional_info, brandGuidelines),
        companyInfo: project.company_info,
        graphicToken,
        clientHomepageUrl: project.url ?? "",
        projectId: project.id,
      });
      // buildImagePrompt already prepended the saved-token directives.
      // When per-run extras are present, we re-apply with the merged
      // set so both saved + extras land in the same block.
      promptUsed = extras
        ? applyAdditionalInstructions(stripAdditionalInstructions(built.finalPrompt), mergedDirectives)
        : built.finalPrompt;
    }

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
          prediction_id: "",
        },
      };
    }

    const imageInput = logoUrl ? [logoUrl] : [];
    const gen = await generate({
      prompt: promptUsed,
      aspectRatio: record.aspectRatio,
      imageInput,
      provider: options.provider,
      resumePredictionId: options.resumePredictionId,
    });

    const localPath = await downloadImage({
      url: gen.imageUrl,
      slug,
      imageId: record.imageId,
      runId: options.runId,
    });

    process.stderr.write(
      `[${rowNum}/${totalRows}] cluster=${shortId(record.cluster.id)} asset=${record.asset} id=${record.imageId} status=completed${gen.predictionId ? ` pred=${gen.predictionId}` : ""}\n`,
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
        prediction_id: gen.predictionId ?? "",
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // ReplicateGenerationError (and any other thrower attaching
    // prediction_id) lets us record the in-flight prediction id on
    // the failed row, so a later regenerate can resume it instead of
    // paying for a fresh prediction.
    const failedPredictionId =
      err && typeof err === "object" && "prediction_id" in err
        ? (err as { prediction_id?: string }).prediction_id
        : undefined;
    process.stderr.write(
      `[${rowNum}/${totalRows}] cluster=${shortId(record.cluster.id)} asset=${record.asset} id=${record.imageId} status=failed error=${message.slice(0, 200)}${failedPredictionId ? ` pred=${failedPredictionId}` : ""}\n`,
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
        prediction_id: failedPredictionId ?? "",
      },
    };
  }
}

export async function runRegen(options: RegenOptions): Promise<void> {
  loadEnv();
  const slug = options.client;

  // Accept allow-list slug OR raw project_id (UUID). Matches the web
  // UI's live DB search, which lets operators pick any project.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let entry = findClient(slug);
  if (!entry && UUID_RE.test(slug)) entry = { slug, projectId: slug };
  if (!entry) {
    process.stderr.write(
      `error: '${slug}' is not in the allow-list and isn't a valid project UUID\n`,
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

  const overrides = await loadProjectOverrides(slug);
  if (overrides.logo_url) {
    process.stderr.write(
      `regen: logo_url=overridden by graphic-tokens/${slug}-overrides.json (${overrides.logo_url.slice(0, 60)}…)\n`,
    );
  }

  let graphicToken: unknown = null;
  let tokenSource: TokenSource = "live";
  if (options.mock) {
    process.stderr.write(`regen: mock mode — skipping graphic_token resolution\n`);
    graphicToken = { mock: true };
    tokenSource = "live";
  } else {
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
  }

  const pageTypeOpt: PageType | PageType[] = options.pageType ?? "blog";
  const clusters = await listPublishedClusters(project.id, pageTypeOpt);
  const pageTypeLabel = Array.isArray(pageTypeOpt) ? pageTypeOpt.join("+") : pageTypeOpt;
  process.stderr.write(`regen: ${clusters.length} published ${pageTypeLabel} clusters\n`);

  const records = await collectImageRecords(clusters, {
    // collectImageRecords expects a single PageType; when multi, we
    // pass undefined so it derives the page_type from each cluster row.
    pageType: Array.isArray(pageTypeOpt) ? undefined : pageTypeOpt,
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
    run_id: options.runId ?? null,
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

  const logoUrl = pickLogoUrl(project, overrides.logo_url ?? null);
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
