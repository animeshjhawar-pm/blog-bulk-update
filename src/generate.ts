import { generateImage } from "./replicate.js";
import { generateImageViaFal } from "./fal.js";
import { loadEnv } from "./env.js";

export type Provider = "replicate" | "fal";

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

  const r = await generateImage({
    prompt: params.prompt,
    aspectRatio: params.aspectRatio,
    imageInput: params.imageInput,
    model: "google/nano-banana-pro",
    resumePredictionId: params.resumePredictionId,
  });
  return { imageUrl: r.image_url, provider, predictionId: r.prediction_id };
}
