import { scrapeClientSite } from "./firecrawl.js";
import { callPortkey } from "./portkey.js";
import { loadToken, saveToken, type GraphicToken } from "./tokens.js";
import { lookupProjectGraphicToken } from "./db.js";
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

export type TokenSource = "live" | "saved" | "db";

export interface ResolveTokenParams {
  slug: string;
  url: string;
  projectId: string;
  /** When true, fail unless the saved token file exists; never call Firecrawl. */
  useSavedToken: boolean;
}

/**
 * Resolution order (DB-first, with the legacy paths kept as fallbacks):
 *
 *   1. `projects.graphic_token` JSONB. This is the schema's source of
 *      truth — it's populated by the upstream content pipeline and
 *      kept in sync per project. Preferred for every run.
 *
 *   2. (only when --use-saved-token) the on-disk file
 *      `graphic-tokens/<slug>.json`. Kept so the PM-iteration mode
 *      still works against pinned files.
 *
 *   3. live Firecrawl + Portkey extraction. The original Mode A path,
 *      now only reached when the DB has no graphic_token AND the run
 *      didn't request a saved file. Existence-of-this-fallback is the
 *      reason we did NOT delete extractToken altogether.
 */
export async function resolveGraphicToken(
  params: ResolveTokenParams,
): Promise<{ token: GraphicToken; source: TokenSource }> {
  // 1. DB first — same for both modes.
  try {
    const fromDb = await lookupProjectGraphicToken(params.projectId);
    if (fromDb) {
      process.stderr.write(
        `regen: graphic_token=db (projects.graphic_token for ${params.projectId})\n`,
      );
      return { token: fromDb as GraphicToken, source: "db" };
    }
  } catch (err) {
    process.stderr.write(
      `regen: graphic_token db lookup failed (${(err as Error).message}) — falling through\n`,
    );
  }

  // 2. Mode B: saved file is REQUIRED — error out rather than silently
  // scraping live (this preserves the original strict semantics of
  // --use-saved-token, which exists so PM-tuned files don't get
  // accidentally bypassed by a live extract).
  if (params.useSavedToken) {
    const saved = await loadToken(params.slug);
    if (!saved) {
      throw new Error(
        `--use-saved-token set, projects.graphic_token is empty, and graphic-tokens/${params.slug}.json is missing. ` +
          `Either backfill projects.graphic_token for this project, or run: npm run extract-token -- --client ${params.slug}`,
      );
    }
    process.stderr.write(`regen: graphic_token=saved (graphic-tokens/${params.slug}.json)\n`);
    return { token: saved, source: "saved" };
  }

  // 3. Final fallback — live extract.
  process.stderr.write(
    `regen: graphic_token not in DB — falling back to live Firecrawl + Portkey extract\n`,
  );
  const token = await liveExtract({
    slug: params.slug,
    url: params.url,
    projectId: params.projectId,
  });
  process.stderr.write(`regen: graphic_token=live (in-memory, not written to disk)\n`);
  return { token, source: "live" };
}
