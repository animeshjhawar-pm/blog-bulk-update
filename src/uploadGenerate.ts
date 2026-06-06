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
import { compositeProduct, emptyZoneDirective, productReferenceDirective } from "./composite.js";

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
  /**
   * Operator-supplied structural reference images for this run. When
   * present they REPLACE the default WIREFRAME_URLS lookup for the
   * matching asset type. Used as image_input[1] on the Replicate call.
   * URLs must be publicly fetchable from Replicate's side (so http(s)
   * URLs the operator pasted, OR the web server's wireframe-serve
   * route when running on a public host like Railway).
   */
  customWireframes?: { cover?: string; thumbnail?: string };
  /**
   * Public base URL the CLI prepends to per-image product paths when
   * service/category asset rows need to pass the operator's uploaded
   * product image to Replicate as a reference image (the AI then
   * generates a new scene using it as a visual anchor, rather than
   * us sharp-compositing a flat paste). When unset, service/category
   * rows fall back to the legacy compositing behaviour — useful for
   * local development where Replicate cannot fetch from localhost.
   * The web server populates this from publicBaseUrlFromReq().
   */
  productBaseUrl?: string;
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

  const productEntry = options.products[record.imageId];
  if (!productEntry) {
    const msg = `no product supplied for image_id ${record.imageId} — Upload & Generate requires one product (dropped file or pasted URL) per picked image`;
    process.stderr.write(`[${rowNum}/${totalRows}] cluster=${shortId(record.cluster.id)} asset=${record.asset} id=${record.imageId} status=failed error=${msg}\n`);
    return {
      status: "failed",
      row: { ...baseRow, prompt_used: "", image_url_new: "", image_local_path: "", status: "failed", error: msg, prediction_id: "" },
    };
  }

  // Each entry is either a local path (dropped file) or a public
  // http(s) URL (operator paste). The URL form lets the operator
  // bypass the localhost-reachability constraint for service/
  // category by hosting their own product image elsewhere.
  const isProductUrl = /^https?:\/\//i.test(productEntry);
  const productUrlFromEntry = isProductUrl ? productEntry : null;
  const productPathFromEntry = isProductUrl ? null : productEntry;

  // Load bytes when needed. Composite path (blog assets) always
  // needs bytes; the service/category AI-reference path may not need
  // them when the URL is passed directly.
  let productBytes: Buffer;
  try {
    if (productPathFromEntry) {
      productBytes = await fs.readFile(productPathFromEntry);
    } else {
      // URL entry — fetch bytes so the composite fallback (blog
      // assets, or service/category when no productUrl-supplying
      // path) still works. The download is short (~MB) and Replicate
      // fetches the URL independently for AI reference, so this
      // doesn't double the network cost for the AI-reference path.
      const r = await fetch(productUrlFromEntry!);
      if (!r.ok) throw new Error(`HTTP ${r.status} fetching product URL`);
      productBytes = Buffer.from(await r.arrayBuffer());
    }
  } catch (err) {
    const msg = `cannot load product (${productPathFromEntry ?? productUrlFromEntry}): ${(err as Error).message}`;
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
  // Asset-aware directive policy:
  //
  //   cover/thumbnail → use the cover.ts prompt + add ONLY the
  //     FLAT SEAM rule. Everything else (logo, pill, title, subtitle,
  //     brand styling) is driven by the cover.ts template and the
  //     wireframe reference image — same as the Generate flow.
  //     The FLAT SEAM rule alone is necessary because product
  //     compositing pastes a real photograph over the right half;
  //     any shadow/depth treatment the AI draws at the vertical
  //     midpoint would then sit between the AI's text column and
  //     the operator's product photo, looking like an awkward
  //     separator. Removing just that one element keeps the rest of
  //     the cover prompt's output intact.
  //
  //   everything else (infographic, internal, external, generic,
  //     service_h1, service_body, category_industry) → still emit the
  //     central-zone directive. These asset templates have NO wireframe
  //     reference image, so the AI needs explicit guidance about
  //     keeping the centre clear for the product composite.
  const FLAT_SEAM_CLAUSE =
    "FLAT SEAM — HARD CONSTRAINT: the LEFT HALF and RIGHT HALF of this image MUST sit flat against each other at the vertical midpoint. " +
    "Do NOT render any drop shadow, inner shadow, soft shadow, dark edge, vignette, gradient fade, bevel, glow, depth effect, " +
    "separator line, layered-card appearance, or floating-element treatment at or near the vertical midpoint or the left edge of the right half. " +
    "The two halves are coplanar, not stacked — a product photograph will be composited over the right half after generation, and any seam treatment would read as an awkward divider between the text column and the product.";
  const usesWireframeLayout = record.asset === "cover" || record.asset === "thumbnail";
  // Determine whether we'll be passing the product to Replicate as a
  // reference image_input. The directive selection below picks the
  // PRODUCT REFERENCE preservation directive in that case (instead of
  // the central-zone one), so the AI knows the reference must be kept.
  const usesProductReference =
    record.asset === "service_h1" ||
    record.asset === "service_body" ||
    record.asset === "category_industry";
  const willPassProductUrl =
    usesProductReference &&
    !!(productUrlFromEntry
      ?? (options.productBaseUrl
        ? `${options.productBaseUrl.replace(/\/+$/, "")}/${encodeURIComponent(record.imageId)}`
        : null));
  const seamDirective = usesWireframeLayout ? FLAT_SEAM_CLAUSE : "";
  // For service/category WITH a product URL we add the preservation
  // directive (forces the AI to treat image_input[1] as a fixed asset
  // and only regenerate background/scene). For everything else
  // non-wireframe we add the central-zone directive (which assumes
  // sharp will composite the product into the central zone post-gen).
  const zoneDirective = usesWireframeLayout
    ? ""
    : (willPassProductUrl
      ? productReferenceDirective(record.asset)
      : emptyZoneDirective(record.asset, null));
  const mergedDirectives = [savedDirectives, extras, seamDirective, zoneDirective]
    .filter((s): s is string => !!s && s.length > 0)
    .join("\n\n");

  let promptUsed = "";
  try {
    // ── Service / category with product URL → SIMPLE prompt path ──
    //
    // page.ts (the prompt Claude builds from) was written for the
    // Generate flow which has no product reference — it instructs the
    // AI to invent the product from the description text. Layering our
    // "preserve image_input[1]" directive on top of that fights the
    // base prompt and the description-driven generation wins (product
    // gets re-interpreted, original is lost).
    //
    // For this code path we BYPASS Claude / page.ts entirely and build
    // a small, focused prompt directly: "image_input[1] is the product,
    // generate the SCENE around it based on this description." That
    // way nothing in the prompt asks the AI to render a product —
    // there's only one source of the product (the reference image).
    //
    // The Generate flow's use of page.ts stays untouched.
    if (willPassProductUrl) {
      // Operator may have edited the "Page" group in the Review Prompts
      // modal; if so, use their text verbatim. Otherwise use the
      // service-flow default prompt verbatim. Nothing else is appended.
      const operatorPageOverride =
        typeof options.promptOverrides?.page?.system === "string"
          && options.promptOverrides.page.system.trim().length > 0
          ? options.promptOverrides.page.system
          : null;

      const defaultServicePrompt =
        `You are an expert image editor. You will receive one or more reference images containing a subject and its branded/product elements. Your task is to generate a NEW image that preserves the subject's identity and all branded elements EXACTLY while completely changing the background, environment, lighting, and surrounding context.\n\n` +
        `WHAT MUST BE PRESERVED (100% IDENTICAL — DO NOT ALTER):\n\n` +
        `The subject's face, features, skin tone, hair, and expression (if a person is present)\n` +
        `All clothing, accessories, and worn items exactly as shown\n` +
        `Any product, vehicle, or object the subject is using or holding — its exact shape, color, design, panels, and proportions\n` +
        `Every logo, brand mark, badge, label, and text — including exact colors, fonts, placement, size, and orientation\n` +
        `The subject's pose, posture, and the camera angle/viewpoint of the subject\n\n` +
        `WHAT TO CHANGE (FULL CREATIVE FREEDOM):\n\n` +
        `The entire background and environment\n` +
        `Surrounding objects, vehicles, people, structures, and scenery\n` +
        `Time of day, lighting conditions, weather, and atmospheric mood\n` +
        `Background depth-of-field, blur, and motion as appropriate\n\n` +
        `TECHNICAL & STYLE REQUIREMENTS:\n\n` +
        `Photorealistic, high-resolution, professional commercial photography quality\n` +
        `Lighting on the subject must realistically match the NEW environment — consistent shadows, reflections, highlights, and color temperature\n` +
        `Natural integration: the subject must look genuinely photographed in the new location, never pasted or composited\n` +
        `Keep the subject in sharp focus; apply natural, context-appropriate background blur or motion\n` +
        `Match perspective and scale so the subject sits believably within the new scene\n\n` +
        `NEGATIVE CONSTRAINTS (AVOID):\n\n` +
        `Do NOT alter, distort, recolor, relocate, or duplicate any logo, badge, or text\n` +
        `Do NOT change the subject's identity, face, clothing, or any product/object design or color\n` +
        `No warped or illegible branding, no text artifacts, no extra or missing limbs, no distorted proportions\n` +
        `No change to the subject itself — only the world around it changes`;

      promptUsed = operatorPageOverride ? operatorPageOverride : defaultServicePrompt;

      process.stderr.write(
        `[${rowNum}/${totalRows}] id=${record.imageId} prompt=product-reference (` +
        (operatorPageOverride ? "operator-edited page prompt" : "default constructed") +
        `; image_input[1] is the product)\n`,
      );
    } else {
      // Original path — Claude builds the prompt from the asset's
      // template (cover.ts / page.ts / etc.). Used by blog assets and
      // by service/category WITHOUT a product URL (composite fallback).
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
    // buildImagePrompt already prepended a directives block with
    // savedDirectives (from graphic_token.additional_instructions).
    // For cover/thumbnail we add ONLY the FLAT SEAM rule on top of
    // that; for other assets we add the central-zone directive.
    // Either way we strip the existing block and re-apply with the
    // merged set so saved + extras + seam (or zone) live together.
    // When mergedDirectives is empty (no savedDirectives, no extras,
    // not a wireframe asset, no central-zone needed) we pass through
    // unchanged — matches Generate exactly in that edge case.
    if (mergedDirectives.length > 0) {
      promptUsed = applyAdditionalInstructions(
        stripAdditionalInstructions(built.finalPrompt),
        mergedDirectives,
      );
    } else {
      promptUsed = built.finalPrompt;
    }
    } // end of else branch (non-product-reference path through buildImagePrompt)

    // Asset-aware routing — service/category use the product as an AI
    // reference (image_input[1]) when a URL is available; everything
    // else (and service/category WITHOUT a URL) goes through sharp
    // compositing. The directive at the top of the prompt was already
    // selected accordingly above (productReferenceDirective vs
    // emptyZoneDirective vs FLAT SEAM clause for cover/thumbnail).
    const productUrl = usesProductReference
      ? (productUrlFromEntry
        ?? (options.productBaseUrl
          ? `${options.productBaseUrl.replace(/\/+$/, "")}/${encodeURIComponent(record.imageId)}`
          : null))
      : null;

    // Reference images sent to Replicate, in order:
    //   [0] brand logo (if available)
    //   [1] cover/thumbnail wireframe OR operator product (service/category)
    const imageInput: string[] = [];
    if (logoUrl) imageInput.push(logoUrl);
    const customWireframeUrl =
      record.asset === "cover" ? options.customWireframes?.cover :
      record.asset === "thumbnail" ? options.customWireframes?.thumbnail :
      undefined;
    const wireframe = customWireframeUrl ?? WIREFRAME_URLS[record.asset];
    if (wireframe) imageInput.push(wireframe);
    if (productUrl) imageInput.push(productUrl);

    const gen = await generate({
      prompt: promptUsed,
      aspectRatio: record.aspectRatio,
      imageInput,
      provider: options.provider,
    });

    // Download the AI output bytes.
    const bgResp = await fetch(gen.imageUrl);
    if (!bgResp.ok) {
      throw new Error(`replicate output fetch HTTP ${bgResp.status}`);
    }
    const bgBytes = Buffer.from(await bgResp.arrayBuffer());

    await fs.mkdir(outImagesDir, { recursive: true });
    const outPath = path.join(outImagesDir, `${safeBasename(record.imageId)}.png`);
    let finalBytes: Buffer;
    let summary: string;

    if (usesProductReference && productUrl) {
      // AI generated the final image using the product as a reference.
      // Just persist the AI output directly — no composite pass.
      finalBytes = bgBytes;
      summary = `ai-reference (no composite) pred=${gen.predictionId ?? ""}`;
    } else {
      // Blog asset OR service/category without a public productBaseUrl
      // (local dev fallback). Composite product onto AI scene via sharp.
      const composed = await compositeProduct({
        background: bgBytes,
        product: productBytes,
        asset: record.asset,
      });
      finalBytes = composed.bytes;
      summary =
        `composite bg=${composed.width}x${composed.height} ` +
        `zone=${composed.zone.width}x${composed.zone.height}@${composed.zone.left},${composed.zone.top} ` +
        `product=${composed.productRendered.width}x${composed.productRendered.height} ` +
        `pred=${gen.predictionId ?? ""}`;
      if (usesProductReference && !productUrl) {
        summary += " (NOTE: no productBaseUrl available — fell back to composite; service/category prefer AI reference path)";
      }
    }
    await fs.writeFile(outPath, finalBytes);

    process.stderr.write(
      `[${rowNum}/${totalRows}] cluster=${shortId(record.cluster.id)} asset=${record.asset} id=${record.imageId} status=completed ${summary}\n`,
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

  // Left-half pixel recolor is disabled — the AI's rendering of the
  // left half (logo, pill, title, subtitle, brand styling) is kept
  // exactly as Replicate produced it. Run-wide visual consistency
  // comes from the operator-supplied wireframe reference (when
  // provided), which gives Replicate a visual blueprint to copy.
  process.stderr.write(
    `upload-generate: left half = AI rendering as-is (no pixel recolor); right half = product fit:cover edge-to-edge\n`,
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
    // Persist the operator-supplied custom wireframes so per-image
    // Regenerate (which spawns a fresh CLI subprocess) can pick them
    // up from the manifest and reuse the same references — keeping
    // single-image regenerates visually consistent with the rest of
    // the run.
    custom_wireframes: options.customWireframes ?? null,
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
