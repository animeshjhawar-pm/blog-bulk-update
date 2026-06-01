import { promises as fs } from "node:fs";
import path from "node:path";
import { loadEnv } from "./env.js";
import { runOutDir } from "./runOutDir.js";
import {
  closePool,
  listPublishedClusters,
  lookupProjectById,
  type PageType,
} from "./db.js";
import { resolveGraphicToken, type TokenSource } from "./extractToken.js";
import { loadBrandGuidelines, loadProjectOverrides } from "./tokens.js";
import {
  buildImagePrompt,
  applyAdditionalInstructions,
  stripAdditionalInstructions,
  extractAdditionalInstructions,
  type PromptOverrides,
} from "./buildPrompt.js";
import { generate, type Provider } from "./generate.js";
import { openCsv, type CsvRow, type CsvWriter } from "./csv.js";
import { writeHtmlReport } from "./html.js";
import { makeLimiter } from "./concurrency.js";
import {
  collectImageRecords,
  type AssetType,
  type ImageRecord,
} from "./pageInfo.js";
import { findClient } from "./clients.js";
import { pickLogoUrl } from "./regen.js";
import { compositeProduct, emptyZoneDirective, extractRunBackgroundColor } from "./composite.js";

/**
 * Upload-&-Generate pipeline.
 *
 * Parallel to regen.ts. The key differences:
 *
 *   1. Per-image product file. The operator supplies one product
 *      photograph per selected image_id. The CLI receives a JSON
 *      manifest mapping image_id → absolute path.
 *
 *   2. Empty-zone prompt. The asset prompt is suffixed with
 *      `emptyZoneDirective(asset)` so Replicate leaves space for the
 *      composite (right half on cover, full frame on thumbnail,
 *      central 60% elsewhere).
 *
 *   3. Post-composite. After Replicate returns the background, sharp
 *      pastes the operator's product into the zone — pixel-perfect.
 *      The CSV row's `image_local_path` points at the composited
 *      PNG; `image_url_new` stays empty (no remote URL — the result
 *      only ever exists on this volume).
 *
 *   4. No --dry-run, no --mock. This flow needs the actual generated
 *      bytes to composite against; a dry-run wouldn't produce a
 *      useful artifact.
 *
 * Everything downstream — the manifest, the CSV header, the run page,
 * Apply/Regenerate buttons — works unmodified because the output
 * shape is identical to regen.
 */

const WIREFRAME_URLS: Partial<Record<AssetType, string>> = {
  cover: "https://raw.githubusercontent.com/animeshjhawar-pm/imagegen-playground/main/public/cover.png",
  thumbnail: "https://raw.githubusercontent.com/animeshjhawar-pm/imagegen-playground/main/public/thumbnail.png",
};

export interface UploadGenerateOptions {
  client: string;
  /** image_id → absolute path to the operator's product file. Every
   *  image we generate must have an entry here; missing images are
   *  emitted as `status=failed` with a clear error. */
  products: Record<string, string>;
  /** Same set of UUIDs the operator picked in the workspace. */
  clusterIds?: Set<string>;
  /** Restrict to this exact set of image_ids — drives which records
   *  collectImageRecords keeps. The keys of `products` must be a
   *  subset of this. */
  imageIds?: Set<string>;
  pageType?: PageType | PageType[];
  /** Stable id for /runs/<id> URL. */
  runId?: string;
  provider?: Provider;
  concurrency: number;
  /** Pass through to buildImagePrompt. */
  promptOverrides?: PromptOverrides;
  /** Free-text addendum, same shape as regen's. */
  extraInstructions?: string;
}

function utcStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "Z");
}

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 8) : id;
}

function mergeBusinessContext(raw: unknown, brandGuidelines: string | null): unknown {
  if (!brandGuidelines) return raw;
  const base =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : { source: raw };
  return { ...base, client_brand_guidelines: brandGuidelines };
}

function safeBasename(s: string): string {
  return s.replace(/[^a-z0-9._-]+/gi, "_").replace(/_+/g, "_").slice(0, 120);
}

interface RowResult {
  row: CsvRow;
  status: "completed" | "failed";
}

async function processOne(args: {
  record: ImageRecord;
  project: Awaited<ReturnType<typeof lookupProjectById>>;
  graphicToken: unknown;
  brandGuidelines: string | null;
  logoUrl: string | null;
  options: UploadGenerateOptions;
  rowNum: number;
  totalRows: number;
  slug: string;
  outImagesDir: string;
}): Promise<RowResult> {
  const { record, project, graphicToken, brandGuidelines, logoUrl, options, rowNum, totalRows, slug, outImagesDir } = args;
  if (!project) throw new Error("processOne: project is null"); // satisfies TS

  const generatedAt = new Date().toISOString();
  const baseRow = {
    image_id: record.imageId,
    asset_type: record.asset,
    cluster_id: record.cluster.id,
    page_topic: record.cluster.topic ?? "",
    description_used: record.description,
    aspect_ratio: record.aspectRatio,
    generated_at_utc: generatedAt,
    client_slug: slug,
    project_id: project.id,
    previous_image_url: record.previewUrl ?? "",
  };

  const productPath = options.products[record.imageId];
  if (!productPath) {
    const msg = `no product file supplied for image_id ${record.imageId} — Upload & Generate requires one product per picked image`;
    process.stderr.write(`[${rowNum}/${totalRows}] cluster=${shortId(record.cluster.id)} asset=${record.asset} id=${record.imageId} status=failed error=${msg}\n`);
    return {
      status: "failed",
      row: { ...baseRow, prompt_used: "", image_url_new: "", image_local_path: "", status: "failed", error: msg, prediction_id: "" },
    };
  }

  // Read product bytes once. We need them both for composite AND we
  // pass the same file to Replicate as a reference image so the
  // model can color/lighting-match the background to the product.
  // The reference role does NOT relax the empty-zone directive — that
  // text still pins the model away from rendering a product inside
  // the zone; the reference is purely for tonal coherence.
  let productBytes: Buffer;
  try {
    productBytes = await fs.readFile(productPath);
  } catch (err) {
    const msg = `cannot read product file at ${productPath}: ${(err as Error).message}`;
    process.stderr.write(`[${rowNum}/${totalRows}] id=${record.imageId} status=failed error=${msg}\n`);
    return {
      status: "failed",
      row: { ...baseRow, prompt_used: "", image_url_new: "", image_local_path: "", status: "failed", error: msg, prediction_id: "" },
    };
  }

  // Compose directives. Order:
  //   saved graphic_token additional_instructions
  //   one-off extras for this run
  //   empty-zone directive (always — drives the post-composite contract)
  const savedDirectives = extractAdditionalInstructions(graphicToken);
  const extras = (options.extraInstructions ?? "").trim();
  // Pin a single background colour for the whole run so cover and
  // thumbnail across every cluster share the same left-half look.
  // If the graphic_token has no usable colour, the directive falls
  // back to solid white inside emptyZoneDirective.
  const runBgColor = extractRunBackgroundColor(graphicToken);
  const zoneDirective = emptyZoneDirective(record.asset, runBgColor);
  const mergedDirectives = [savedDirectives, extras, zoneDirective]
    .filter((s): s is string => !!s && s.length > 0)
    .join("\n\n");

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
      promptOverrides: options.promptOverrides,
      blogTopic: record.cluster.topic ?? "",
      aspectRatio: record.aspectRatio,
    });
    // Re-apply the directives so the empty-zone block is at the top
    // alongside saved + extras. buildImagePrompt already prepended
    // only the saved set; we need the merged set instead.
    promptUsed = applyAdditionalInstructions(
      stripAdditionalInstructions(built.finalPrompt),
      mergedDirectives,
    );

    // Reference images sent to Replicate, in this order:
    //   [0] brand logo (if available)
    //   [1] layout wireframe for cover/thumbnail (matches regen.ts)
    //   [2] product image (URL = file://… won't work — Replicate fetches
    //       over HTTPS only. We'd need to host the product somewhere
    //       Replicate can reach. For v1 we DO NOT pass the product as
    //       a reference; the empty-zone directive is what drives the
    //       background. The product is pasted post-generation; the AI
    //       never sees it. This keeps "must NOT be AI-modified" 100%
    //       guaranteed — there is no path by which AI even observes
    //       the product pixels.)
    const imageInput: string[] = [];
    if (logoUrl) imageInput.push(logoUrl);
    const wireframe = WIREFRAME_URLS[record.asset];
    if (wireframe) imageInput.push(wireframe);

    const gen = await generate({
      prompt: promptUsed,
      aspectRatio: record.aspectRatio,
      imageInput,
      provider: options.provider,
    });

    // Download the background bytes for compositing. Replicate signed
    // URLs are good for ~1h; we fetch immediately so the bytes land
    // before the URL can expire.
    const bgResp = await fetch(gen.imageUrl);
    if (!bgResp.ok) {
      throw new Error(`replicate output fetch HTTP ${bgResp.status}`);
    }
    const bgBytes = Buffer.from(await bgResp.arrayBuffer());

    // Composite product into the zone. Output is PNG so the product
    // pixels are byte-exact (no JPEG/WebP ringing at edges).
    // leftHalfTargetColor enforces the same background colour across
    // every cover and thumbnail in this run — the AI's choice is
    // overridden in pixel-space inside compositeProduct.
    const composed = await compositeProduct({
      background: bgBytes,
      product: productBytes,
      asset: record.asset,
      leftHalfTargetColor: runBgColor,
    });

    await fs.mkdir(outImagesDir, { recursive: true });
    const outPath = path.join(outImagesDir, `${safeBasename(record.imageId)}.png`);
    await fs.writeFile(outPath, composed.bytes);

    process.stderr.write(
      `[${rowNum}/${totalRows}] cluster=${shortId(record.cluster.id)} asset=${record.asset} id=${record.imageId} ` +
      `status=completed bg=${composed.width}x${composed.height} ` +
      `zone=${composed.zone.width}x${composed.zone.height}@${composed.zone.left},${composed.zone.top} ` +
      `product=${composed.productRendered.width}x${composed.productRendered.height} ` +
      `pred=${gen.predictionId ?? ""}\n`,
    );

    return {
      status: "completed",
      row: {
        ...baseRow,
        prompt_used: promptUsed,
        // No remote URL — the composite never leaves the volume until
        // Apply uploads it through the Gushwork media API.
        image_url_new: "",
        image_local_path: outPath,
        status: "completed",
        error: "",
        prediction_id: gen.predictionId ?? "",
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failedPredictionId =
      err && typeof err === "object" && "prediction_id" in err
        ? (err as { prediction_id?: string }).prediction_id
        : undefined;
    process.stderr.write(
      `[${rowNum}/${totalRows}] id=${record.imageId} status=failed error=${message.slice(0, 200)}${failedPredictionId ? ` pred=${failedPredictionId}` : ""}\n`,
    );
    return {
      status: "failed",
      row: {
        ...baseRow,
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

export async function runUploadGenerate(options: UploadGenerateOptions): Promise<void> {
  loadEnv();
  const slug = options.client;

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let entry = findClient(slug);
  if (!entry && UUID_RE.test(slug)) entry = { slug, projectId: slug };
  if (!entry) {
    process.stderr.write(`error: '${slug}' is not in the allow-list and isn't a valid project UUID\n`);
    await closePool();
    process.exit(2);
  }

  const project = await lookupProjectById(entry.projectId);
  if (!project) {
    process.stderr.write(`error: project ${entry.projectId} not found in DB\n`);
    await closePool();
    process.exit(2);
  }
  process.stderr.write(`upload-generate: client='${project.name ?? slug}' project_id=${project.id}\n`);

  const brandGuidelines = await loadBrandGuidelines(slug);
  if (brandGuidelines) {
    process.stderr.write(
      `upload-generate: brand_guidelines=loaded (${brandGuidelines.length} chars)\n`,
    );
  }

  const overrides = await loadProjectOverrides(slug);

  let graphicToken: unknown = null;
  let tokenSource: TokenSource = "live";
  try {
    const resolved = await resolveGraphicToken({
      slug,
      url: project.url ?? "",
      projectId: project.id,
      // Prefer the saved token — the workspace flow always has one
      // (Upload & Generate is reachable only after the operator
      // landed on the workspace, which itself runs an extract).
      useSavedToken: true,
    });
    graphicToken = resolved.token;
    tokenSource = resolved.source;
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    await closePool();
    process.exit(3);
  }

  // Surface the run-wide pinned background colour at startup so it
  // shows in the live log on the run page. Helps the operator
  // verify (or debug) why cover/thumbnail came back in a given
  // colour — and confirms the uniformity guarantee is wired up.
  const runBgPreview = extractRunBackgroundColor(graphicToken);
  process.stderr.write(
    `upload-generate: pinned left-half background = ${runBgPreview ?? "(fallback) #FFFFFF"}\n`,
  );

  const pageTypeOpt: PageType | PageType[] = options.pageType ?? "blog";
  const clusters = await listPublishedClusters(project.id, pageTypeOpt);
  process.stderr.write(`upload-generate: ${clusters.length} candidate clusters\n`);

  const records = await collectImageRecords(clusters, {
    pageType: Array.isArray(pageTypeOpt) ? undefined : pageTypeOpt,
    clusterIds: options.clusterIds,
    imageIds: options.imageIds,
    stagingSubdomain: project.staging_subdomain,
  });
  process.stderr.write(
    `upload-generate: ${records.length} records to process (${Object.keys(options.products).length} product file(s) supplied)\n`,
  );
  if (records.length === 0) {
    process.stderr.write(`upload-generate: nothing to do — exiting\n`);
    await closePool();
    return;
  }

  const stamp = utcStamp();
  const outDir = runOutDir();
  await fs.mkdir(outDir, { recursive: true });

  const csvPath = path.join(outDir, `${slug}-upgen-${stamp}.csv`);
  const htmlPath = csvPath.replace(/\.csv$/, ".html");
  const manifestPath = path.join(outDir, `manifest-upgen-${stamp}.json`);
  const outImagesDir = options.runId
    ? path.join(outDir, "runs", options.runId, "images")
    : path.join(outDir, "images", slug);

  const csv: CsvWriter = await openCsv(csvPath);
  process.stderr.write(`upload-generate: writing ${csvPath}\n`);

  const startedAt = new Date().toISOString();
  const baseManifest = {
    run_id: options.runId ?? null,
    mode: "upload-generate" as const,
    client: slug,
    client_name: project.name,
    project_id: project.id,
    cluster_ids: options.clusterIds ? [...options.clusterIds] : null,
    image_ids: options.imageIds ? [...options.imageIds] : null,
    token_source: tokenSource,
    provider: options.provider ?? loadEnv().IMAGE_PROVIDER,
    concurrency: options.concurrency,
    page_type: Array.isArray(pageTypeOpt) ? pageTypeOpt : [pageTypeOpt],
    started_at: startedAt,
    csv: csvPath,
    csv_basename: path.basename(csvPath),
    html: htmlPath,
    html_basename: path.basename(htmlPath),
    total_rows: records.length,
    products_count: Object.keys(options.products).length,
  };
  await fs.writeFile(manifestPath, JSON.stringify(baseManifest, null, 2) + "\n", "utf8");

  const logoUrl = pickLogoUrl(project, overrides.logo_url ?? null, overrides.logo_disabled === true);
  if (!logoUrl) {
    process.stderr.write(
      `upload-generate: warning — no primary_logo URL; image_input will skip logo\n`,
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
        outImagesDir,
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
    dry_run: 0,
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
    `upload-generate: done — ${summary.ok} ok, ${summary.failed} failed\n`,
  );
  process.stderr.write(`upload-generate: csv=${csvPath}\nupload-generate: html=${htmlPath}\n`);
}
