import { callPortkey } from "./portkey.js";
import { interpolate } from "./interpolate.js";
import {
  GENERATE_INFOGRAPHIC_SYSTEM_PROMPT_NEW,
  GENERATE_INFOGRAPHIC_USER_TEMPLATE_NEW,
} from "./prompts/infographic.js";
import {
  BLOG_COVER_SYSTEM_PROMPT_NEW,
  BLOG_COVER_USER_TEMPLATE_NEW,
} from "./prompts/cover.js";
import { INTERNAL_SYSTEM_PROMPT, INTERNAL_USER_TEMPLATE } from "./prompts/internal.js";
import { EXTERNAL_SYSTEM_PROMPT, EXTERNAL_USER_TEMPLATE } from "./prompts/external.js";
import { GENERIC_SYSTEM_PROMPT, GENERIC_USER_TEMPLATE } from "./prompts/generic.js";
import type { AssetType } from "./pageInfo.js";

function templatesFor(asset: AssetType): { system: string; user: string } {
  switch (asset) {
    case "infographic":
      return {
        system: GENERATE_INFOGRAPHIC_SYSTEM_PROMPT_NEW,
        user: GENERATE_INFOGRAPHIC_USER_TEMPLATE_NEW,
      };
    case "cover":
    case "thumbnail":
      return { system: BLOG_COVER_SYSTEM_PROMPT_NEW, user: BLOG_COVER_USER_TEMPLATE_NEW };
    case "internal":
      return { system: INTERNAL_SYSTEM_PROMPT, user: INTERNAL_USER_TEMPLATE };
    case "external":
      return { system: EXTERNAL_SYSTEM_PROMPT, user: EXTERNAL_USER_TEMPLATE };
    case "generic":
      return { system: GENERIC_SYSTEM_PROMPT, user: GENERIC_USER_TEMPLATE };
    // Service + category assets all route to the generic page-image
    // prompt pair — same shape as `internal`. The asset_type is still
    // preserved in the CSV for downstream observability.
    case "service_h1":
    case "service_body":
    case "category_industry":
      return { system: INTERNAL_SYSTEM_PROMPT, user: INTERNAL_USER_TEMPLATE };
  }
}

function extractAdditionalInstructions(token: unknown): string | null {
  if (!token || typeof token !== "object") return null;
  const v = (token as Record<string, unknown>).additional_instructions;
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed ? trimmed : null;
}

function safeJsonStringify(v: unknown): string {
  if (v == null) return "{}";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function stripFinalPromptWrapper(text: string): string {
  const wrappers: Array<[RegExp, RegExp]> = [
    [/<final_prompt>/i, /<\/final_prompt>/i],
    [/<cover_image_prompt>/i, /<\/cover_image_prompt>/i],
  ];
  let out = text.trim();
  for (const [open, close] of wrappers) {
    const o = out.search(open);
    const c = out.search(close);
    if (o >= 0 && c > o) {
      out = out.slice(out.indexOf(">", o) + 1, c).trim();
      break;
    }
  }
  return out;
}

export interface BuildPromptParams {
  asset: AssetType;
  imageDescription: string;
  businessContext: unknown;
  companyInfo: unknown;
  graphicToken: unknown;
  clientHomepageUrl?: string;
  projectId: string;
  /** Optional cover/thumbnail extras. Undefined fields collapse to "". */
  subtitle?: string;
  categoryLabel?: string;
}

export interface BuildPromptResult {
  finalPrompt: string;
  rawResponse: object;
}

/**
 * Append the operator's additional_instructions to the prompt that
 * will be handed to Replicate. Two design choices worth calling out:
 *
 *   1. Position — we PREPEND. Image-gen models (Flux, Nano Banana,
 *      etc.) read the entire prompt; there's no formal priority
 *      mechanism, but putting brand directives at the top of the
 *      prompt keeps them salient and unmissable.
 *
 *   2. Wording — the wrapper is explicitly imperative ("MUST",
 *      "override any visual choice below"). The model is being told
 *      that anything below is subordinate, which empirically biases
 *      Replicate's image models toward honouring the directives.
 *
 * We append at THIS layer (post-Claude, pre-Replicate) instead of
 * relying on Claude to splice the directives into its output. That
 * proved unreliable in practice — Claude would paraphrase or drop
 * parts of the directive. By appending here we guarantee the text
 * reaches Replicate verbatim every time, and the same string also
 * lands in the CSV as `prompt_used` so single-image Regenerate (which
 * skips Claude) inherits the directives unchanged.
 */
const BRAND_OPEN = "[TOP-PRIORITY BRAND DIRECTIVES — these MUST be followed and override any visual choice in the description that follows]";
const BRAND_CLOSE = "[/TOP-PRIORITY BRAND DIRECTIVES]";
const BRAND_RE = new RegExp(
  `${escapeRegex(BRAND_OPEN)}[\\s\\S]*?${escapeRegex(BRAND_CLOSE)}\\s*`,
  "g",
);
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function applyAdditionalInstructions(
  basePrompt: string,
  additionalInstructions: string | null,
): string {
  const trimmed = (additionalInstructions ?? "").trim();
  if (!trimmed) return basePrompt;
  return [
    BRAND_OPEN,
    trimmed,
    BRAND_CLOSE,
    "",
    basePrompt,
  ].join("\n");
}

/**
 * Remove any previously-injected brand-directives block from a prompt
 * so it can be re-applied with the latest additional_instructions.
 * Used by single-image Regenerate so a user who updated their brand
 * guidelines doesn't keep getting stale directives carried forward.
 */
export function stripAdditionalInstructions(prompt: string): string {
  return prompt.replace(BRAND_RE, "").trimStart();
}

export { extractAdditionalInstructions };

export async function buildImagePrompt(params: BuildPromptParams): Promise<BuildPromptResult> {
  const { asset } = params;
  const { system, user } = templatesFor(asset);

  // The operator's additional_instructions are NOT injected into the
  // Claude system prompt anymore — Claude is left to do its job, and
  // we append the directives ourselves AFTER it returns. That makes
  // the post-Claude prompt the single source of truth for what
  // Replicate sees.
  const additionalInstructions = extractAdditionalInstructions(params.graphicToken);

  const userPrompt = interpolate(user, {
    placeholder_description: params.imageDescription ?? "",
    business_context: safeJsonStringify(params.businessContext),
    company_info: safeJsonStringify(params.companyInfo),
    graphic_token: safeJsonStringify(params.graphicToken),
    client_homepage_url: params.clientHomepageUrl ?? "",
    subtitle: params.subtitle ?? "",
    category_label: params.categoryLabel ?? "",
    additional_instructions: additionalInstructions ?? "",
  });

  const result = await callPortkey({
    model: "claude-sonnet-4-6",
    systemPrompt: system,
    userPrompt,
    maxTokens: 64000,
    metadata: {
      step_name: "build_image_prompt",
      flow_type: "new",
      client_id: params.projectId,
      project_id: params.projectId,
    },
  });

  const finalPrompt = applyAdditionalInstructions(
    stripFinalPromptWrapper(result.text),
    additionalInstructions,
  );

  return {
    finalPrompt,
    rawResponse: result.rawResponse,
  };
}
