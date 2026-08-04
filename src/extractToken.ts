import { scrapeClientSite } from "./firecrawl.js";
import { callPortkey, detectPortkeyEnv } from "./portkey.js";
import { loadOperatorToken, saveToken, type GraphicToken } from "./tokens.js";
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
      service: "image-update-tool",
      env: detectPortkeyEnv(),
      sub_step: "extract_graphic_token",
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

export type TokenSource = "live" | "saved" | "db" | "operator";

export interface ResolveTokenParams {
  slug: string;
  url: string;
  projectId: string;
  /** When true, fail unless the saved token file exists; never call Firecrawl. */
  useSavedToken: boolean;
}

/**
 * Resolution order (runtime override beats stored token; NO live
 * extract fallback):
 *
 *   1. OPERATOR layer — `<OPERATOR_DIR>/<slug>.json`. The workspace
 *      dashboard's "Save token" writes here. If the operator edited
 *      the graphic_token mid-run, this is what they want used —
 *      otherwise their dashboard change does nothing.
 *
 *   2. `projects.graphic_token` JSONB in the DB. The schema's source
 *      of truth, populated by the upstream content pipeline. 615/617
 *      stormbreaker projects have this backfilled — the DB is the
 *      only path we actually need for regen.
 *
 * If both miss, we FAIL LOUDLY rather than silently scrape+Portkey.
 * Operator remedy is either backfill projects.graphic_token or hit
 * the "⚡ Extract now" button in the workspace UI, which explicitly
 * runs a live extract (runExtractTokenCli) and saves the result.
 *
 * The bundled `graphic-tokens/<slug>.json` and live Firecrawl+Portkey
 * fallbacks used to sit under this function. Both were removed
 * because (a) the 5 pinned bundled clients all have DB tokens now,
 * and (b) the live path was silently costing Firecrawl+Portkey $ on
 * every regen for the 2 projects missing a token, when the correct
 * fix is to backfill the DB row once.
 */
export async function resolveGraphicToken(
  params: ResolveTokenParams,
): Promise<{ token: GraphicToken; source: TokenSource }> {
  // 1. Operator runtime override always wins.
  try {
    const fromOperator = await loadOperatorToken(params.slug);
    if (fromOperator) {
      process.stderr.write(
        `regen: graphic_token=operator (runtime override saved via the workspace UI)\n`,
      );
      return { token: fromOperator, source: "operator" };
    }
  } catch (err) {
    process.stderr.write(
      `regen: operator graphic_token read failed (${(err as Error).message}) — falling through\n`,
    );
  }

  // 2. DB.
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

  // Neither operator override nor DB row — fail loudly. Silently
  // falling back to a live Firecrawl+Portkey extract used to happen
  // here; it was the wrong default (paid, slow, race-prone) when the
  // fix is a one-row DB backfill or a one-click "Extract now" in UI.
  throw new Error(
    `No graphic_token found for project ${params.projectId} (${params.slug}). ` +
      `Backfill projects.graphic_token in stormbreaker, or open the workspace UI ` +
      `and click "⚡ Extract now" for this project to run a live extract and save it.`,
  );
}
