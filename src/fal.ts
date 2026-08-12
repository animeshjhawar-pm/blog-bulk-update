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

// fal.ai's nano-banana-pro types the aspect_ratio field as a strict
// literal union. We accept any ratio string upstream (from graphic
// tokens / operator overrides), so map anything unsupported to the
// closest allowed ratio rather than let the SDK reject the call.
type FalAspect =
  | "auto" | "16:9" | "3:2" | "1:1" | "2:3" | "4:3" | "3:4"
  | "9:16" | "4:5" | "5:4" | "21:9";
const FAL_ASPECT_SET = new Set<FalAspect>([
  "auto", "16:9", "3:2", "1:1", "2:3", "4:3", "3:4", "9:16", "4:5", "5:4", "21:9",
]);
function coerceFalAspect(v: string | undefined): FalAspect | null {
  if (!v) return null;
  if (FAL_ASPECT_SET.has(v as FalAspect)) return v as FalAspect;
  // Map by ratio value onto the nearest supported one, so a
  // graphic-token "1.91:1" (say) still lands somewhere reasonable.
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(v);
  if (!m) return "1:1";
  const w = Number(m[1]), h = Number(m[2]);
  if (!(w > 0) || !(h > 0)) return "1:1";
  const r = w / h;
  if (r >= 2.2) return "21:9";
  if (r >= 1.65) return "16:9";
  if (r >= 1.4) return "3:2";
  if (r >= 1.25) return "4:3";
  if (r >= 1.1) return "5:4";
  if (r >= 0.9) return "1:1";
  if (r >= 0.75) return "4:5";
  if (r >= 0.65) return "3:4";
  if (r >= 0.6) return "2:3";
  return "9:16";
}

// ---------------------------------------------------------------------------
// Nano-banana-pro on fal.ai — the escape hatch when Replicate has
// nano-banana-pro globally rate-limited (E003) and our retry budget is
// exhausted. Different provider, different capacity pool, same
// underlying Google model so style matches Replicate-generated
// siblings as closely as any fallback could.
//
// Two endpoints because fal.ai's SDK types split them: `/edit` is
// image-to-image (requires image_urls); the base is text-to-image.
// We pick per-call based on whether the caller has reference images
// — matching the same split Replicate does internally for the
// nano-banana-pro endpoint.
// ---------------------------------------------------------------------------
export async function generateImageViaFalNanoBanana(
  params: FalGenerateImageParams,
): Promise<FalImageResult> {
  configureFalOnce();

  const hasRefs = Boolean(params.imageInput && params.imageInput.length > 0);
  const result = hasRefs
    ? await fal.subscribe("fal-ai/nano-banana-pro/edit", {
        input: {
          prompt: params.prompt,
          image_urls: params.imageInput!,
          num_images: 1,
          ...(coerceFalAspect(params.aspectRatio)
            ? { aspect_ratio: coerceFalAspect(params.aspectRatio)! }
            : {}),
        },
        logs: false,
      })
    : await fal.subscribe("fal-ai/nano-banana-pro", {
        input: {
          prompt: params.prompt,
          num_images: 1,
          ...(coerceFalAspect(params.aspectRatio)
            ? { aspect_ratio: coerceFalAspect(params.aspectRatio)! }
            : {}),
        },
        logs: false,
      });
  const data = (result?.data ?? result) as { images?: { url?: string }[] };
  const url = data?.images?.[0]?.url ?? "";
  if (!url) {
    throw new Error(
      `fal.ai nano-banana-pro returned no image URL. Raw response: ${JSON.stringify(result).slice(0, 300)}`,
    );
  }
  return { image_url: url };
}
