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
}

export interface GenerateResult {
  imageUrl: string;
  provider: Provider;
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
  });
  return { imageUrl: r.image_url, provider };
}
