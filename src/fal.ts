// ---------------------------------------------------------------------------
// fal.ai provider — used by the Blog v2 (custom:cover_thumbnail) pipeline
// when the user picks "openai/gpt-image-2" as the model. fal.ai's hosted
// gpt-image-2 endpoint accepts the same `prompt` + `image_urls[]` shape
// as OpenAI directly and tends to be faster / less rate-limited than
// Replicate's gpt-image-2 mirror, which is why we route this single
// (pipeline, model) combo here.
//
// Auth: Authorization: Key <FAL_KEY>  (the SDK reads from process.env.FAL_KEY)
// Endpoint: "openai/gpt-image-2/edit"
//
// Reference cURL we're matching (per the user-supplied client snippet):
//   const { request_id } = await fal.queue.submit("openai/gpt-image-2/edit", {
//     input: { prompt, image_urls: ["..."] },
//   });
// ---------------------------------------------------------------------------

import { fal } from "@fal-ai/client";

export interface FalGenerateImageParams {
  prompt: string;
  /** Reference images (existing image, logo, etc.). fal.ai expects a
   *  string[] under `image_urls`. Empty / missing imageInput → omit. */
  imageInput?: string[];
  /** Aspect-ratio hint sent through to fal.ai. gpt-image-2 accepts
   *  "1:1" | "3:2" | "2:3" | "16:9". */
  aspectRatio?: string;
}

export interface FalImageResult {
  image_url: string;
}

const FAL_ENDPOINT = "openai/gpt-image-2/edit";

let _falConfigured = false;
function configureFalOnce() {
  if (_falConfigured) return;
  const key = process.env.FAL_KEY;
  if (!key) {
    throw new Error(
      "FAL_KEY is not set. Local: add `FAL_KEY=...` to .env.local and restart `npm run dev`.",
    );
  }
  fal.config({ credentials: key });
  _falConfigured = true;
}

export async function generateImageViaFal(
  params: FalGenerateImageParams,
): Promise<FalImageResult> {
  configureFalOnce();

  const input: Record<string, unknown> = {
    prompt: params.prompt,
  };
  if (params.imageInput && params.imageInput.length > 0) {
    input.image_urls = params.imageInput;
  }
  if (params.aspectRatio) {
    // fal.ai's gpt-image-2 endpoint accepts the standard ratio string.
    input.aspect_ratio = params.aspectRatio;
  }

  // fal.subscribe submits the job and polls until completion (or
  // failure). It returns the model's full result payload — for
  // gpt-image-2/edit that's `{ images: [{ url, width?, height? }, ...] }`
  // (matching OpenAI's image-edit response shape, with fal.ai's URL
  // scheme on the `url` field).
  const result = await fal.subscribe(FAL_ENDPOINT, {
    input,
    logs: false,
  });

  // The SDK returns { data, requestId } — extract the image URL.
  const data = (result?.data ?? result) as { images?: { url?: string }[] };
  const url = data?.images?.[0]?.url ?? "";
  if (!url) {
    throw new Error(
      `fal.ai returned no image URL. Raw response: ${JSON.stringify(result).slice(0, 300)}`,
    );
  }
  return { image_url: url };
}
