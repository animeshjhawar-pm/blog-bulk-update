import { scrapeClientSite } from "./firecrawl.js";
import { callPortkey } from "./portkey.js";
import { loadToken, loadOperatorToken, saveToken, type GraphicToken } from "./tokens.js";
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

export type TokenSource = "live" | "saved" | "db" | "operator";

export interface ResolveTokenParams {
  slug: string;
  url: string;
  projectId: string;
  /** When true, fail unless the saved token file exists; never call Firecrawl. */
  useSavedToken: boolean;
}

/**
 * Resolution order (runtime override beats everything; DB beats bundled
 * defaults; live extract is the last resort):
 *
 *   1. OPERATOR layer — `<OPERATOR_DIR>/<slug>.json`. The workspace
 *      dashboard's "Save token" writes here. If the operator edited
 *      the graphic_token mid-run, this is what they want used —
 *      otherwise their dashboard change does nothing.
 *
 *   2. `projects.graphic_token` JSONB in the DB. The schema's source
 *      of truth, populated by the upstream content pipeline.
 *
 *   3. BUNDLED layer — `graphic-tokens/<slug>.json` committed to the
 *      repo. The 5 pinned clients (sentinel/specgas/...) ship with
 *      these as a fallback for when DB hasn't been backfilled.
 *      (`loadToken` reads operator-then-bundled; since (1) already
 *      checked operator, this call effectively reaches bundled only.)
 *
 *   4. Live Firecrawl + Portkey extraction. Last resort.
 *
 * Mode B (`--use-saved-token`, CLI flag) still requires SOMETHING
 * concrete to exist — operator/DB/bundled — and errors before
 * falling back to a live extract, preserving the "don't silently
 * scrape when I asked for the saved one" semantics.
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

  // 3. Bundled (and, on local dev where there's no operator layer,
  // also any locally-saved token). loadToken does operator-then-bundled
  // — operator was already checked above, so in production this only
  // reaches bundled.
  const fromBundled = await loadToken(params.slug);
  if (fromBundled) {
    process.stderr.write(`regen: graphic_token=saved (graphic-tokens/${params.slug}.json)\n`);
    return { token: fromBundled, source: "saved" };
  }

  // Mode B fail-fast.
  if (params.useSavedToken) {
    throw new Error(
      `--use-saved-token set, but no graphic_token found in operator dir, projects.graphic_token, or graphic-tokens/${params.slug}.json. ` +
        `Backfill projects.graphic_token, save an override via the workspace UI, or run: npm run extract-token -- --client ${params.slug}`,
    );
  }

  // 4. Final fallback — live extract.
  process.stderr.write(
    `regen: graphic_token not in operator/DB/bundled — falling back to live Firecrawl + Portkey extract\n`,
  );
  const token = await liveExtract({
    slug: params.slug,
    url: params.url,
    projectId: params.projectId,
  });
  process.stderr.write(`regen: graphic_token=live (in-memory, not written to disk)\n`);
  return { token, source: "live" };
}
