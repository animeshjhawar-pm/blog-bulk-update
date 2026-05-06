import { scrapeClientSite } from "./firecrawl.js";
import { callPortkey } from "./portkey.js";
import { loadToken, saveToken, type GraphicToken } from "./tokens.js";
import { interpolate } from "./interpolate.js";
import {
  EXTRACT_GRAPHIC_TOKEN_SYSTEM_PROMPT,
  EXTRACT_GRAPHIC_TOKEN_USER_TEMPLATE,
} from "./prompts/extract.js";

function stripWrappers(text: string): string {
  let out = text.trim();

  const xml = out.match(/<output_json>([\s\S]*?)<\/output_json>/);
  if (xml && xml[1]) out = xml[1].trim();

  const fenced = out.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenced && fenced[1]) out = fenced[1].trim();

  return out;
}

async function liveExtract(params: {
  slug: string;
  url: string;
  projectId: string;
}): Promise<GraphicToken> {
  process.stderr.write(`extract-token: scraping ${params.url}\n`);
  const fc = await scrapeClientSite(params.url);

  const userPrompt = interpolate(EXTRACT_GRAPHIC_TOKEN_USER_TEMPLATE, {
    markdown: fc.markdown ?? "",
    branding: JSON.stringify(fc.branding ?? {}, null, 2),
  });

  process.stderr.write(`extract-token: calling portkey (claude-sonnet-4-6)\n`);
  const result = await callPortkey({
    model: "claude-sonnet-4-6",
    systemPrompt: EXTRACT_GRAPHIC_TOKEN_SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 16000,
    metadata: {
      step_name: "extract_graphic_token",
      flow_type: "new",
      client_id: params.slug,
      project_id: params.projectId,
    },
  });

  const cleaned = stripWrappers(result.text);
  try {
    return JSON.parse(cleaned) as GraphicToken;
  } catch (err) {
    throw new Error(
      `extract-token: portkey response was not valid JSON after wrapper-stripping: ${(err as Error).message}\n--- response head ---\n${cleaned.slice(0, 400)}`,
    );
  }
}

/**
 * Standalone command — always extracts live and writes to disk.
 * Used in mode B (PM iterates on the saved file before regen).
 */
export async function runExtractTokenCli(params: {
  slug: string;
  url: string;
  projectId: string;
}): Promise<{ token: GraphicToken; tokenPath: string }> {
  const token = await liveExtract(params);
  const target = await saveToken(params.slug, token);
  process.stderr.write(`extract-token: wrote ${target}\n`);
  return { token, tokenPath: target };
}

export type TokenSource = "live" | "saved";

export interface ResolveTokenParams {
  slug: string;
  url: string;
  projectId: string;
  /** When true, fail unless the saved token file exists; never call Firecrawl. */
  useSavedToken: boolean;
}

/**
 * Mode A (default, useSavedToken=false): scrape + extract live every run,
 * keep the token in memory only, never touch disk.
 *
 * Mode B (useSavedToken=true): load `graphic-tokens/<slug>.json`, fail
 * fast if the file isn't there, never call Firecrawl.
 */
export async function resolveGraphicToken(
  params: ResolveTokenParams,
): Promise<{ token: GraphicToken; source: TokenSource }> {
  if (params.useSavedToken) {
    const saved = await loadToken(params.slug);
    if (!saved) {
      throw new Error(
        `--use-saved-token set but graphic-tokens/${params.slug}.json is missing. Run: npm run extract-token -- --client ${params.slug}`,
      );
    }
    process.stderr.write(`regen: graphic_token=saved (graphic-tokens/${params.slug}.json)\n`);
    return { token: saved, source: "saved" };
  }

  const token = await liveExtract({
    slug: params.slug,
    url: params.url,
    projectId: params.projectId,
  });
  process.stderr.write(`regen: graphic_token=live (in-memory, not written to disk)\n`);
  return { token, source: "live" };
}
