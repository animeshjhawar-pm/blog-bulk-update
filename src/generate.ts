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
    return { imageUrl: r.image_url, provider };
  }

  try {
    const r = await generateImage({
      prompt: params.prompt,
      aspectRatio: params.aspectRatio,
      imageInput: params.imageInput,
      model: "google/nano-banana-pro",
      resumePredictionId: params.resumePredictionId,
    });
    return { imageUrl: r.image_url, provider, predictionId: r.prediction_id };
  } catch (err) {
    // Replicate has nano-banana-pro globally rate-limited (E003) and
    // even our 8-attempt / ~42-min backoff exhausted. Escape to fal.ai's
    // nano-banana endpoint — different capacity pool, similar-enough
    // style that the image slots into the run without looking obviously
    // different next to its siblings. Only fires when FAL_KEY is set;
    // otherwise the Replicate error rethrows unchanged.
    if (!isReplicateRateLimitError(err) || !process.env.FAL_KEY) throw err;
    process.stderr.write(
      `generate: Replicate E003 exhausted retry budget — falling back to fal.ai nano-banana\n`,
    );
    try {
      const fb = await generateImageViaFalNanoBanana({
        prompt: params.prompt,
        imageInput: params.imageInput,
        aspectRatio: params.aspectRatio,
      });
      process.stderr.write(`generate: fal.ai fallback succeeded\n`);
      // provider="fal" so downstream (CSV, HTML report) records which
      // path produced this image — helps diagnose style drift later.
      return { imageUrl: fb.image_url, provider: "fal" };
    } catch (fbErr) {
      // Fallback also failed — throw the ORIGINAL Replicate error so
      // the operator sees the real root cause (E003), not the fal
      // downstream error which would obscure it.
      process.stderr.write(
        `generate: fal.ai fallback ALSO failed (${(fbErr as Error).message}) — rethrowing original Replicate error\n`,
      );
      throw err;
    }
  }
}
