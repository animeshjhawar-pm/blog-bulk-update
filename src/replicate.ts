// ---------------------------------------------------------------------------
// Replicate provider — Step 5: generate_image
//
// Supports three models (selected per-step via stepConfig.model):
//   • google/nano-banana-pro   — default ($0.15 / img @ 2K)
//   • google/nano-banana-2     — adds image_search / google_search toggles
//   • bytedance/seedream-4     — enhance_prompt on, max_images=1
//
// All three use the same /predictions endpoint + poll flow; only the input
// shape and endpoint path differ.
// ---------------------------------------------------------------------------

export type ImageModel =
  | "google/nano-banana-pro"
  | "google/nano-banana-2"
  | "bytedance/seedream-4"
  | "openai/gpt-image-2"
  | "black-forest-labs/flux-2-flex";

export const DEFAULT_IMAGE_MODEL: ImageModel = "google/nano-banana-pro";

export interface ReplicateResult {
  image_url: string;
}

export interface GenerateImageParams {
  prompt: string;
  aspectRatio: string;
  imageInput?: string[];
  model?: ImageModel;
  /** nano-banana-2 only. */
  imageSearch?: boolean;
  /** nano-banana-2 only. */
  googleSearch?: boolean;
}

// Default polling budget — Vercel function timeout is 300s, leave ~15s
// headroom for the POST + final serialization. Most models settle well
// within this: nano-banana-pro is usually 10–30s, nano-banana-2 ~40s,
// seedream-4 ~40s, gpt-image-2 ~60–120s.
const DEFAULT_MAX_WAIT_MS = 280_000; // 280s
// gpt-image-2 routinely takes 2–5 min for img2img with two reference
// images (its OpenAI backend is slower than Gemini's, and content
// moderation adds latency). Give it a longer leash so we don't bail
// before Replicate finishes. This will time out a Vercel-deployed
// function, but locally with the default Next dev server (no timeout)
// it works fine — and that's where the playground actually runs.
const GPT_IMAGE_2_MAX_WAIT_MS = 540_000; // 9 min
const POLL_INTERVAL = 2_000;             // 2s between polls

function maxWaitMsForModel(model: ImageModel): number {
  return model === "openai/gpt-image-2" ? GPT_IMAGE_2_MAX_WAIT_MS : DEFAULT_MAX_WAIT_MS;
}
// Replicate supports `Prefer: wait=<seconds>` (max 60) — the initial POST
// holds the connection open until either the prediction finishes or the
// wait window elapses. For fast models this lets us skip polling entirely.
const INITIAL_WAIT_SECONDS = 60;
// Matches stormbreaker's services/replicate/replicate.py:
// @backoff.on_exception(backoff.expo, Exception, max_tries=3)
const MAX_RETRIES   = 3;

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * gpt-image-2 aspect handling. Replicate's schema enum advertises
 * "1:1" | "3:2" | "2:3", but the underlying model also accepts "16:9"
 * (per the model's own docs — confirmed by user 2026-05-06). Anything
 * outside that extended set is mapped to the closest supported ratio
 * so the user can switch models on pipelines that lock to other
 * ratios without hitting a 422 from Replicate.
 *
 * Mapping for non-allowed ratios — wider-than-square → 3:2,
 * taller-than-square → 2:3, square-ish → 1:1.
 */
function mapAspectRatioForGptImage2(ratio: string): "1:1" | "3:2" | "2:3" | "16:9" {
  if (ratio === "1:1" || ratio === "3:2" || ratio === "2:3" || ratio === "16:9") return ratio;
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ratio);
  if (!m) return "1:1"; // Unparseable — safe default.
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!(w > 0) || !(h > 0)) return "1:1";
  const r = w / h;
  if (r > 1.1) return "3:2"; // 4:3, 5:3, etc. (16:9 is now passthrough)
  if (r < 0.9) return "2:3"; // 9:16, 3:4, etc.
  return "1:1";
}

function buildModelInput(
  model: ImageModel,
  p: GenerateImageParams
): Record<string, unknown> {
  const { prompt, aspectRatio, imageInput } = p;

  if (model === "google/nano-banana-pro") {
    // Full canonical payload shape per the model's Replicate schema:
    //   { prompt, resolution, image_input[], aspect_ratio, output_format,
    //     safety_filter_level, allow_fallback_model }
    // safety_filter_level=block_only_high is critical — the default
    // (block_some / block_most) frequently refuses amp-up prompts as
    // chat-style "I'm just a language model and can't help with that"
    // responses, which Replicate translates into the opaque
    // "No image content found in response" error.
    const input: Record<string, unknown> = {
      prompt,
      resolution:           "2K",
      aspect_ratio:         aspectRatio,
      image_input:          imageInput ?? [],
      output_format:        "png",
      safety_filter_level:  "block_only_high",
      allow_fallback_model: false,
    };
    return input;
  }

  if (model === "google/nano-banana-2") {
    return {
      prompt,
      aspect_ratio: aspectRatio,
      resolution: "2K",
      image_input: imageInput ?? [],
      image_search: p.imageSearch ?? false,
      google_search: p.googleSearch ?? false,
      output_format: "jpg",
    };
  }

  if (model === "bytedance/seedream-4") {
    return {
      prompt,
      aspect_ratio: aspectRatio,
      size: "2K",
      width: 2048,
      height: 2048,
      max_images: 1,
      image_input: imageInput ?? [],
      enhance_prompt: true,
      sequential_image_generation: "disabled",
    };
  }

  if (model === "black-forest-labs/flux-2-flex") {
    // Blog-infographic-only option. Input shape matches the reference
    // cURL — steps=30, guidance=4.5, resolution="1 MP", WEBP output at
    // q80. `input_images` always sent as an array (empty when no logo
    // is provided).
    return {
      prompt,
      steps: 30,
      guidance: 4.5,
      resolution: "1 MP",
      aspect_ratio: aspectRatio,
      input_images: imageInput ?? [],
      output_format: "webp",
      output_quality: 80,
      safety_tolerance: 2,
      prompt_upsampling: true,
    };
  }

  if (model === "openai/gpt-image-2") {
    // gpt-image-2 uses `input_images` (not `image_input`) and — contrary
    // to some older sample cURLs floating around — expects a plain array
    // of URL strings. Wrapping each URL in `{ value: url }` triggers a
    // 422 from Replicate: `input.input_images.0: Invalid type. Expected:
    // string, given: object`.
    //
    // Allowed `aspect_ratio` values on this model are a strict enum:
    // "1:1" | "3:2" | "2:3". Any other ratio (e.g. 16:9 which blog:cover
    // and blog:infographic lock to) returns another 422: `aspect_ratio
    // must be one of the following: "1:1", "3:2", "2:3"`. Map the
    // pipeline's requested ratio to the closest supported one so the
    // user can still pick gpt-image-2 on those pipelines without hitting
    // a validation error.
    return {
      prompt,
      quality: "high",
      background: "auto",
      moderation: "auto",
      aspect_ratio: mapAspectRatioForGptImage2(aspectRatio),
      input_images: imageInput ?? [],
      output_format: "webp",
      number_of_images: 1,
      output_compression: 90,
    };
  }

  throw new Error(`Unknown image model: ${model}`);
}

export async function generateImage(params: GenerateImageParams): Promise<ReplicateResult> {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) {
    throw new Error(
      "REPLICATE_API_TOKEN is not set. Local: add to .env.local and restart `npm run dev`. Vercel: add in Project Settings → Environment Variables, then redeploy."
    );
  }

  const model = params.model ?? DEFAULT_IMAGE_MODEL;
  const input = buildModelInput(model, params);
  const endpoint = `https://api.replicate.com/v1/models/${model}/predictions`;

  // POST prediction with retry on transient failures. Uses
  // `Prefer: wait=<seconds>` so a fast prediction can come back in the
  // POST response with status=succeeded and we skip polling entirely.
  let predictionId: string | null = null;
  let immediateResult: ReplicateResult | null = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Token ${token}`,
          "Content-Type": "application/json",
          Prefer: `wait=${INITIAL_WAIT_SECONDS}`,
        },
        body: JSON.stringify({ input }),
      });

      if (resp.status === 401) {
        throw new Error("Replicate auth error (401). Check REPLICATE_API_TOKEN.");
      }
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(
          `Replicate create prediction (${model}) ${resp.status}: ${body.slice(0, 300)}`
        );
      }

      const json = (await resp.json()) as {
        id?: string;
        status?: string;
        output?: string | string[];
        error?: string;
      };
      if (json.error) throw new Error(`Replicate error: ${json.error}`);
      if (!json.id)   throw new Error("Replicate returned no prediction ID");
      // Happy path: `Prefer: wait` held the connection until the prediction
      // completed — no polling needed.
      if (json.status === "succeeded") {
        const image_url = Array.isArray(json.output) ? json.output[0] : (json.output ?? "");
        if (!image_url) throw new Error("Replicate succeeded but output was empty");
        immediateResult = { image_url };
      } else if (json.status === "failed" || json.status === "canceled") {
        throw new Error(
          `Replicate prediction ${json.status}: ${json.error ?? "no error message"}`
        );
      }
      predictionId = json.id;
      break;
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      await sleep(Math.pow(2, attempt - 1) * 1000); // exponential backoff: 1s, 2s, 4s
    }
  }

  if (immediateResult) return immediateResult;
  if (!predictionId)   throw new Error("Failed to create Replicate prediction");

  // Poll until succeeded or failed. Polling budget is per-model: longer
  // for gpt-image-2 (its OpenAI backend is slower than Gemini's and
  // moderation adds latency).
  const maxWaitMs = maxWaitMsForModel(model);
  const deadline  = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL);

    const pollResp = await fetch(
      `https://api.replicate.com/v1/predictions/${predictionId}`,
      { headers: { Authorization: `Token ${token}` } }
    );

    if (!pollResp.ok) {
      const body = await pollResp.text().catch(() => "");
      throw new Error(`Replicate poll error ${pollResp.status}: ${body.slice(0, 200)}`);
    }

    const status = (await pollResp.json()) as {
      status: string;
      output?: string | string[];
      error?: string;
    };

    if (status.status === "succeeded") {
      const raw = status.output;
      const image_url = Array.isArray(raw) ? raw[0] : (raw ?? "");
      if (!image_url) throw new Error("Replicate succeeded but output was empty");
      return { image_url };
    }

    if (status.status === "failed" || status.status === "canceled") {
      throw new Error(
        `Replicate prediction ${status.status}: ${status.error ?? "no error message"}`
      );
    }
    // status === 'starting' | 'processing' → keep polling
  }

  throw new Error(`Replicate prediction timed out after ${maxWaitMs / 1000}s`);
}
