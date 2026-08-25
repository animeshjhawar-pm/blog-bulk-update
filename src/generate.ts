import { generateImage } from "./replicate.js";
import { generateImageViaFal, generateImageViaFalNanoBanana } from "./fal.js";
import { generateImageViaFlex, isFlexEnabled, FlexError } from "./gemini.js";
import { loadEnv } from "./env.js";

export type Provider = "replicate" | "fal" | "flex";

// The E003 shape specifically — Replicate telling us the model is
// globally throttled. Distinct from generic infra flakiness because
// the retry inside replicate.ts uses a longer schedule for this one.
function isReplicateRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /ModelRateLimitError|\(E003\)|currently unavailable due to high demand/i.test(msg);
}

// Widened 2026-08-25: fall to fal.ai on ANY Replicate failure EXCEPT
// the two known-permanent shapes where fal can't help. Rationale:
// per-image fal cost is $0.039 vs an operator having to Regenerate
// manually. Losing $0.039 on a doomed-anyway safety refusal is worse
// than losing operator time, so we explicitly still skip fal on:
//   1. Nano-banana-pro safety-filter refusals — fal runs the SAME
//      underlying model, so its safety filter will refuse too.
//      Prompt needs a human fix, not a provider switch.
//   2. 4xx caller-side errors (auth, malformed input, missing prompt) —
//      fal will 4xx the same request. Nothing changes.
// Everything else — infra flakes, empty outputs, Cloudflare 403,
// timeouts, unwrapped 5xx — gets a fal attempt.
function isReplicateSafetyRefusal(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /safety filter|content policy|content_policy_violation|flagged as unsafe|violates .* usage polic|responsible ai|refused to generate/i.test(msg);
}
function isCallerSide4xx(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /Client error '4(0[0-49]|1\d|2\d|3\d)|Bad request|Unauthorized|Forbidden|Not found|Unprocessable/i.test(msg)
    && !/Client error '429/.test(msg); // 429 = rate-limit → still worth fal
}
function isReplicateTransientInfraError(err: unknown): boolean {
  if (isReplicateSafetyRefusal(err)) return false;
  if (isCallerSide4xx(err)) return false;
  return true;
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
  // Below fields are for Flex (Layer 0) — used for per-attempt
  // journaling to out/runs/flex-attempts.jsonl and for writing the
  // returned bytes to out/runs/<runId>/images/<imageId>.<ext> in one
  // step (avoids a second HTTP hop through rehost).
  runId?: string;
  imageId?: string;
  slug?: string;
  projectId?: string;
  clusterId?: string;
  assetType?: string;
}

export interface GenerateResult {
  imageUrl: string;
  provider: Provider;
  /**
   * Which model produced the image. Distinguishes:
   *   - "gemini-3-pro-image-flex" (Layer 0, Google Flex tier, $0.067)
   *   - "google/nano-banana-pro"   (Layer 1, Replicate, $0.15)
   *   - "fal-nano-banana-pro"      (Layer 2, fal.ai, $0.039)
   * provider alone can't distinguish these — Flex and Replicate
   * primary are the same underlying model at different providers.
   */
  model?:
    | "gemini-3-pro-image-flex"
    | "google/nano-banana-pro"
    | "fal-nano-banana-pro";
  /** Replicate prediction id. Only set when provider="replicate". */
  predictionId?: string;
  /** Which fallback tier served the request. Flex=0, Replicate=1, fal=2. */
  route?: "flex" | "replicate" | "fal";
  /** For Flex only — elapsed ms of the successful attempt. */
  flexElapsedMs?: number;
  /** For Flex only — "success" or "503_retried_success". */
  flexOutcome?: "success" | "503_retried_success";
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

  // Three-layer fallback chain, all serving the same underlying model
  // (Gemini 3 Pro Image = Nano Banana Pro) through three providers so
  // one provider's throttle / capacity drop doesn't sink the run.
  //
  //   Layer 0 · Google Flex  gemini-3-pro-image  ($0.067)  ← cheapest,
  //             synchronous, best-effort. 300s timeout, 1 retry on 503,
  //             no retry on 429 / timeout / other errors (fall through
  //             immediately to Layer 1 — capacity blips rarely clear
  //             within our budget). Skipped entirely when FLEX_ENABLED
  //             ≠ "true" or GEMINI_API_KEY absent.
  //
  //   Layer 1 · Replicate    google/nano-banana-pro  ($0.15)  ← existing
  //             primary. Own in-provider retry budget for E003.
  //
  //   Layer 2 · fal.ai       nano-banana-pro  ($0.039)  ← different
  //             capacity pool. Only fires when Replicate exhausts AND
  //             FAL_KEY is set.
  //
  // The prior Replicate nano-banana-2 tier was removed 2026-08-22 in
  // favour of Flex — same model everywhere now, no style drift risk.
  const flexOn = isFlexEnabled() && !params.resumePredictionId;
  if (flexOn) {
    if (!params.imageId || !params.slug) {
      // Guard for the plumbing — /regen call-sites always set these,
      // one-shot CLIs may not. Skip Flex when we can't attribute the
      // attempt in flex-attempts.jsonl.
      process.stderr.write(`generate: skipping Flex (missing imageId/slug)\n`);
    } else {
      try {
        const flex = await generateImageViaFlex({
          prompt: params.prompt,
          aspectRatio: params.aspectRatio,
          imageInput: params.imageInput,
          runId: params.runId,
          imageId: params.imageId,
          slug: params.slug,
          projectId: params.projectId,
          clusterId: params.clusterId,
          assetType: params.assetType,
        });
        process.stderr.write(
          `generate: Flex served (${flex.outcome}, ${flex.elapsed_ms}ms)\n`,
        );
        return {
          imageUrl: flex.image_url,
          provider: "flex",
          model: "gemini-3-pro-image-flex",
          route: "flex",
          flexElapsedMs: flex.elapsed_ms,
          flexOutcome: flex.outcome,
        };
      } catch (err) {
        const outcome = err instanceof FlexError ? err.outcome : "error";
        process.stderr.write(
          `generate: Flex fell through (${outcome}) — going to Replicate\n`,
        );
        // Fall through to Layer 1 unconditionally.
      }
    }
  }

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
      route: "replicate",
    };
  } catch (err) {
    if (!isReplicateTransientInfraError(err) || !process.env.FAL_KEY) throw err;

    // Layer 2 — fal.ai nano-banana-pro. Different provider, fires on
    // ANY Replicate failure except known-permanent shapes (safety
    // refusals + caller-side 4xx). See classifier above.
    const errMsg = (err as Error)?.message ?? String(err);
    process.stderr.write(
      `generate: Replicate nano-banana-pro failed (${errMsg.slice(0, 160)}) — falling back to fal.ai\n`,
    );
    try {
      const fb = await generateImageViaFalNanoBanana({
        prompt: params.prompt,
        imageInput: params.imageInput,
        aspectRatio: params.aspectRatio,
      });
      process.stderr.write(`generate: fal.ai fallback succeeded\n`);
      return {
        imageUrl: fb.image_url,
        provider: "fal",
        model: "fal-nano-banana-pro",
        route: "fal",
      };
    } catch (fbErr) {
      // Both layers failed — throw the ORIGINAL Replicate error so the
      // operator sees the root cause, not the fal downstream error.
      process.stderr.write(
        `generate: fal.ai fallback ALSO failed (${(fbErr as Error).message}) — rethrowing original Replicate error\n`,
      );
      throw err;
    }
  }
}
