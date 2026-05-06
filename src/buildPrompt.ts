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
  }
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

export async function buildImagePrompt(params: BuildPromptParams): Promise<BuildPromptResult> {
  const { asset } = params;
  const { system, user } = templatesFor(asset);

  const userPrompt = interpolate(user, {
    placeholder_description: params.imageDescription ?? "",
    business_context: safeJsonStringify(params.businessContext),
    company_info: safeJsonStringify(params.companyInfo),
    graphic_token: safeJsonStringify(params.graphicToken),
    client_homepage_url: params.clientHomepageUrl ?? "",
    subtitle: params.subtitle ?? "",
    category_label: params.categoryLabel ?? "",
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

  return {
    finalPrompt: stripFinalPromptWrapper(result.text),
    rawResponse: result.rawResponse,
  };
}
