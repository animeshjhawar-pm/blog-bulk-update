import { generateImage } from "./replicate.js";
import { generateImageViaFal, generateImageViaFalNanoBanana } from "./fal.js";
import { loadEnv } from "./env.js";

export type Provider = "replicate" | "fal";

// Recognise Replicate's global model rate-limit shape so we can escape
// to fal.ai on the far side of Replicate's own retry budget. Same
// classifier that replicate.ts uses internally — factored here so
// generate.ts can see errors that have already exhausted all 8 of
// replicate.ts's rate-limit retries.
function isReplicateRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /ModelRateLimitError|\(E003\)|currently unavailable due to high demand/i.test(msg);
}

export interface GenerateParams {
  prompt: string;
  aspectRatio: string;
  imageInput: string[];
  /** Override the env-resolved default. */
  provider?: Provider;
  /**
   * If set AND provider is Replicate, the call first asks Replicate
   * whether this prediction id has completed. If yes → return its
   * URL with zero new model-spend (the recovery path used by the
   * regenerate-on-failed flow). If no → fall through to a fresh
   * generation. Ignored for fal.
   */
  resumePredictionId?: string;
}

export interface GenerateResult {
  imageUrl: string;
  provider: Provider;
  /**
   * Which model produced the image. Distinguishes the two Replicate
   * paths (nano-banana-pro vs nano-banana-2) for per-image cost
   * tracking — provider alone can't, since both are "replicate".
   * Optional to keep older callers working; absent = default per
   * provider ($0.15 for replicate, $0.039 for fal).
   */
  model?: "google/nano-banana-pro" | "google/nano-banana-2" | "fal-nano-banana-pro";
  /** Replicate prediction id. Only set when provider="replicate". */
  predictionId?: string;
}

export async function generate(params: GenerateParams): Promise<GenerateResult> {
  const env = loadEnv();
  const provider: Provider = params.provider ?? env.IMAGE_PROVIDER;

  if (provider === "fal") {
    const r = await generateImageViaFal({
      prompt: params.prompt,
      imageInput: params.imageInput,
      aspectRatio: params.aspectRatio,
    });
    // The direct-fal path uses openai/gpt-image-2 (see fal.ts), NOT
    // nano-banana. Distinct model so pricing can price it separately
    // if we ever add it to the table.
    return { imageUrl: r.image_url, provider };
  }

  // Three-layer fallback chain — each layer only fires when the layer
  // above hits Replicate's global rate-limit (E003) after exhausting
  // its own in-provider retry budget. Non-rate-limit errors propagate
  // immediately from the layer they hit.
  //
  //   Layer 1 · Replicate  google/nano-banana-pro   (best quality, $0.15)
  //   Layer 2 · Replicate  google/nano-banana-2     (different rate-limit
  //                        bucket at Replicate, ~$0.039 — dodges most
  //                        E003 spells without paying the style-drift
  //                        cost of a provider switch)
  //   Layer 3 · fal.ai     nano-banana-pro          (different provider,
  //                        different capacity pool, ~$0.039)
  //
  // On success we surface which layer produced the image via the
  // returned provider field, so CSV / UI cost tracking attributes
  // correctly.
  try {
    const r = await generateImage({
      prompt: params.prompt,
      aspectRatio: params.aspectRatio,
      imageInput: params.imageInput,
      model: "google/nano-banana-pro",
      resumePredictionId: params.resumePredictionId,
    });
    return {
      imageUrl: r.image_url,
      provider,
      model: "google/nano-banana-pro",
      predictionId: r.prediction_id,
    };
  } catch (err) {
    if (!isReplicateRateLimitError(err)) throw err;

    // Layer 2 — Replicate nano-banana-2. Replicate scopes E003 buckets
    // per model, so the pro throttle usually doesn't apply to -2. Same
    // provider means style stays close and CSV attribution is
    // straightforward (still "replicate", just a different model).
    // Skips resumePredictionId — that id belongs to the pro model and
    // wouldn't resolve against -2.
    process.stderr.write(
      `generate: Replicate nano-banana-pro E003 exhausted — retrying on Replicate nano-banana-2\n`,
    );
    try {
      const r2 = await generateImage({
        prompt: params.prompt,
        aspectRatio: params.aspectRatio,
        imageInput: params.imageInput,
        model: "google/nano-banana-2",
      });
      process.stderr.write(`generate: Replicate nano-banana-2 succeeded\n`);
      return {
        imageUrl: r2.image_url,
        provider,
        model: "google/nano-banana-2",
        predictionId: r2.prediction_id,
      };
    } catch (err2) {
      if (!isReplicateRateLimitError(err2) || !process.env.FAL_KEY) throw err2;

      // Layer 3 — fal.ai nano-banana-pro. Different provider, only fires
      // when both Replicate models are throttled AND FAL_KEY is set.
      process.stderr.write(
        `generate: Replicate nano-banana-2 also E003 — falling back to fal.ai nano-banana-pro\n`,
      );
      try {
        const fb = await generateImageViaFalNanoBanana({
          prompt: params.prompt,
          imageInput: params.imageInput,
          aspectRatio: params.aspectRatio,
        });
        process.stderr.write(`generate: fal.ai fallback succeeded\n`);
        return { imageUrl: fb.image_url, provider: "fal", model: "fal-nano-banana-pro" };
      } catch (fbErr) {
        // All three layers failed — throw the ORIGINAL pro-tier error
        // so the operator sees the root cause (E003 on the primary
        // path), not the fal downstream error which would obscure it.
        process.stderr.write(
          `generate: fal.ai fallback ALSO failed (${(fbErr as Error).message}) — rethrowing original nano-banana-pro error\n`,
        );
        throw err;
      }
    }
  }
}
