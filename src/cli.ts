#!/usr/bin/env node
import { Command, Option } from "commander";
import { loadEnvOrExit } from "./env.js";
import { closePool, lookupProjectById } from "./db.js";
import { runExtractTokenCli } from "./extractToken.js";
import { runRegen } from "./regen.js";
import { runUpload } from "./upload.js";
import { runRepoint } from "./repoint.js";
import { runRevert } from "./revert.js";
import { inspectForSlug } from "./inspectPageInfo.js";
import { findClient, clientSlugList } from "./clients.js";
import { startWebServer } from "./web.js";
import type { Provider } from "./generate.js";
import type { AssetType } from "./pageInfo.js";

const ASSET_TYPES: readonly AssetType[] = [
  "cover",
  "thumbnail",
  "infographic",
  "internal",
  "external",
  "generic",
] as const;

/**
 * Accept either an allow-list slug OR a project_id (UUID) directly.
 * The web UI's live DB search lets operators pick any project; we
 * mirror that here so `npm run regen --client <uuid>` works the same
 * way the workspace URL does.
 */
const UUID_RE_CLI = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function requireKnownClient(slug: string): void {
  if (findClient(slug)) return;
  if (UUID_RE_CLI.test(slug)) return;
  process.stderr.write(
    `error: '${slug}' is not in the allow-list and isn't a valid project UUID. ` +
      `Known slugs: ${clientSlugList().join(", ") || "(none)"}\n`,
  );
  process.exit(2);
}

function parseAssetTypes(raw: string | undefined): Set<AssetType> | undefined {
  if (!raw) return undefined;
  const out = new Set<AssetType>();
  for (const tok of raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (!(ASSET_TYPES as readonly string[]).includes(tok)) {
      process.stderr.write(
        `error: --asset-types value '${tok}' not in {${ASSET_TYPES.join(",")}}\n`,
      );
      process.exit(2);
    }
    out.add(tok as AssetType);
  }
  return out.size > 0 ? out : undefined;
}

function parseClusterIds(raw: string | undefined): Set<string> | undefined {
  if (!raw) return undefined;
  const out = new Set<string>(
    raw.split(",").map((s) => s.trim()).filter(Boolean),
  );
  return out.size > 0 ? out : undefined;
}

const program = new Command();
program
  .name("blog-image-regen")
  .description("Regenerate blog-page images for a hardcoded list of clients.")
  .showHelpAfterError();

program
  .command("inspect-page-info")
  .description("Print the page_info JSON shape of a few real clusters to figure out image extraction.")
  .requiredOption("--client <slug>", `client slug (allow-list: ${clientSlugList().join(", ") || "<empty>"})`)
  .option("--limit <n>", "number of clusters to dump", "1")
  .addOption(
    new Option("--page-type <type>", "page_type to inspect").choices(["blog", "service", "category"]).default("blog"),
  )
  .action(async (opts: { client: string; limit: string; pageType: "blog" | "service" | "category" }) => {
    requireKnownClient(opts.client);
    try {
      loadEnvOrExit();
      const limit = Math.max(1, Number.parseInt(opts.limit, 10) || 1);
      await inspectForSlug(opts.client, limit, opts.pageType);
    } catch (err) {
      process.stderr.write(
        `inspect-page-info failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 1;
    } finally {
      await closePool();
    }
  });

program
  .command("extract-token")
  .description("Scrape the client homepage and write graphic-tokens/<slug>.json (for --use-saved-token edits).")
  .requiredOption("--client <slug>", `client slug (allow-list: ${clientSlugList().join(", ") || "<empty>"})`)
  .action(async (opts: { client: string }) => {
    requireKnownClient(opts.client);
    try {
      loadEnvOrExit();
      let entry = findClient(opts.client);
      if (!entry && UUID_RE_CLI.test(opts.client)) entry = { slug: opts.client, projectId: opts.client };
      if (!entry) {
        process.stderr.write(`error: '${opts.client}' not a known slug or project_id\n`);
        process.exit(2);
      }
      const project = await lookupProjectById(entry.projectId);
      if (!project) {
        process.stderr.write(`error: project ${entry.projectId} not found in DB\n`);
        process.exit(2);
      }
      if (!project.url) {
        process.stderr.write(`error: project ${project.id} has no url to scrape\n`);
        process.exit(3);
      }
      await runExtractTokenCli({ slug: opts.client, url: project.url, projectId: project.id });
    } catch (err) {
      process.stderr.write(
        `extract-token failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 1;
    } finally {
      await closePool();
    }
  });

program
  .command("regen")
  .description("Regenerate blog images for the client; writes CSV + HTML report.")
  .requiredOption("--client <slug>", `client slug (allow-list: ${clientSlugList().join(", ") || "<empty>"})`)
  .option("--dry-run", "build prompts only, no image generation", false)
  .option("--use-saved-token", "load graphic-tokens/<slug>.json (mode B); default scrapes live (mode A)", false)
  .option(
    "--asset-types <list>",
    `comma-separated subset of {${ASSET_TYPES.join(",")}}`,
  )
  .option("--cluster-ids <list>", "comma-separated cluster UUIDs to restrict to")
  .option("--image-ids <list>", "comma-separated image_id values to restrict to (per-image scoping; the web UI uses this)")
  .option(
    "--page-type <types>",
    "page_type(s) to regen — single value (blog/service/category) or comma-separated list. Defaults to 'blog'.",
    "blog",
  )
  .option("--run-id <id>", "stamp this run with a stable id (web UI uses this to link to /runs/<id> after a server restart)")
  .option("--mock", "skip Portkey + image generation; emit synthetic prompts and picsum.photos URLs (UX validation, no API spend)", false)
  .addOption(
    new Option("--provider <name>", "override IMAGE_PROVIDER").choices(["replicate", "fal"]),
  )
  .option("--concurrency <n>", "parallel image generations", "5")
  .option(
    "--prompt-override-file <path>",
    "use the literal text in this file as the image-gen prompt instead of calling Portkey (used by the web UI's Regenerate button to skip the prompt-build step)",
  )
  .option(
    "--extra-instructions-file <path>",
    "merge this file's text into the per-image top-priority block (treated like additional_instructions for this run only — does NOT mutate the saved graphic_token)",
  )
  .option(
    "--resume-prediction-id <id>",
    "before generating, poll Replicate for this prediction id. If it has succeeded, use that URL and skip the new generation (recovers predictions that completed after a prior timeout).",
  )
  .option(
    "--prompt-overrides-file <path>",
    "JSON file with per-run system+user template overrides keyed by prompt group (cover/infographic/page/generic). Shape: { \"<group>\": { \"system\"?: string, \"user\"?: string } }. Used by the workspace's confirm modal; never mutates prompts/*.ts.",
  )
  .action(
    async (opts: {
      client: string;
      dryRun: boolean;
      useSavedToken: boolean;
      assetTypes?: string;
      clusterIds?: string;
      imageIds?: string;
      pageType?: string;
      runId?: string;
      mock?: boolean;
      provider?: Provider;
      concurrency: string;
      promptOverrideFile?: string;
      extraInstructionsFile?: string;
      resumePredictionId?: string;
      promptOverridesFile?: string;
    }) => {
      requireKnownClient(opts.client);
      try {
        const assetTypes = parseAssetTypes(opts.assetTypes);
        const clusterIds = parseClusterIds(opts.clusterIds);
        const imageIds = parseClusterIds(opts.imageIds); // same comma-split semantics
        const concurrency = Math.max(1, Number.parseInt(opts.concurrency, 10) || 5);

        let promptOverride: string | undefined;
        let extraInstructions: string | undefined;
        let promptOverrides: import("./buildPrompt.js").PromptOverrides | undefined;
        if (opts.promptOverrideFile || opts.extraInstructionsFile || opts.promptOverridesFile) {
          const fs = await import("node:fs/promises");
          if (opts.promptOverrideFile) {
            promptOverride = await fs.readFile(opts.promptOverrideFile, "utf8");
          }
          if (opts.extraInstructionsFile) {
            extraInstructions = (await fs.readFile(opts.extraInstructionsFile, "utf8")).trim();
          }
          if (opts.promptOverridesFile) {
            const raw = await fs.readFile(opts.promptOverridesFile, "utf8");
            try {
              promptOverrides = JSON.parse(raw);
            } catch (err) {
              process.stderr.write(
                `regen: ignoring --prompt-overrides-file (invalid JSON): ${(err as Error).message}\n`,
              );
            }
          }
        }

        // --page-type accepts a CSV list ("blog,service") — split and
        // validate. listPublishedClusters already takes PageType[].
        const validPt = new Set(["blog", "service", "category"]);
        const ptList = (opts.pageType ?? "blog")
          .split(",")
          .map((s) => s.trim())
          .filter((s): s is "blog" | "service" | "category" => validPt.has(s));
        if (ptList.length === 0) ptList.push("blog");
        const pageType = ptList.length === 1 ? ptList[0]! : ptList;

        await runRegen({
          client: opts.client,
          dryRun: Boolean(opts.dryRun),
          useSavedToken: Boolean(opts.useSavedToken),
          assetTypes,
          clusterIds,
          imageIds,
          pageType,
          runId: opts.runId,
          mock: Boolean(opts.mock),
          provider: opts.provider,
          concurrency,
          promptOverride,
          extraInstructions,
          resumePredictionId: opts.resumePredictionId,
          promptOverrides,
        });
      } catch (err) {
        process.stderr.write(
          `regen failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
        await closePool();
      }
    },
  );

/**
 * Load a Gushwork bearer token from a file (default ~/.gushwork_token)
 * and reject early if it's missing, empty, or an already-expired JWT —
 * so the operator finds out before every API row 401s. Shared by the
 * `upload` and `repoint` commands.
 */
async function loadTokenOrExit(tokenFileOpt?: string): Promise<string> {
  const os = await import("node:os");
  const fsp = await import("node:fs/promises");
  const tokenFile = tokenFileOpt ?? `${os.homedir()}/.gushwork_token`;
  let token: string;
  try {
    token = (await fsp.readFile(tokenFile, "utf8")).trim();
  } catch {
    process.stderr.write(
      `error: token file not found: ${tokenFile}\n` +
        `Put a fresh token there (1h TTL) from https://platform.gushwork.ai/api/auth/token\n`,
    );
    process.exit(2);
  }
  if (!token) {
    process.stderr.write(`error: token file ${tokenFile} is empty\n`);
    process.exit(2);
  }
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64").toString("utf8"),
    ) as { exp?: number };
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      process.stderr.write(
        `error: token in ${tokenFile} is EXPIRED (exp ${new Date(payload.exp * 1000).toISOString()}). Fetch a fresh one.\n`,
      );
      process.exit(2);
    }
  } catch {
    /* not a decodable JWT — let the API reject it */
  }
  return token;
}

program
  .command("upload")
  .description(
    "Upload every generated image in a regen CSV through the Gushwork media API; " +
      "emit a mapping CSV (old image_id -> new image_id / refined key / CDN urls). " +
      "Does NOT touch page_info.",
  )
  .requiredOption("--csv <path>", "regen CSV to consume (out/<slug>-<utc>.csv)")
  .option(
    "--token-file <path>",
    "file holding a FRESH bearer token (1h TTL; from https://platform.gushwork.ai/api/auth/token). Default: ~/.gushwork_token",
  )
  .option("--out <path>", "mapping CSV output path (default: alongside the input CSV)")
  .option("--base-url <url>", "override the API base (default: prod seo-v2 project base)")
  .option("--no-refine", "send refine=false to the presign call (default: refine=true)")
  .option("--fail-fast", "abort the whole run on the first row failure (default: record + continue)", false)
  .option("--concurrency <n>", "parallel uploads", "4")
  .action(
    async (opts: {
      csv: string;
      tokenFile?: string;
      out?: string;
      baseUrl?: string;
      refine: boolean;
      failFast: boolean;
      concurrency: string;
    }) => {
      try {
        const token = await loadTokenOrExit(opts.tokenFile);
        const concurrency = Math.max(1, Number.parseInt(opts.concurrency, 10) || 4);
        await runUpload({
          csvPath: opts.csv,
          token,
          baseUrl: opts.baseUrl,
          refine: opts.refine !== false,
          failFast: Boolean(opts.failFast),
          concurrency,
          outPath: opts.out,
        });
      } catch (err) {
        process.stderr.write(
          `upload failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
        await closePool();
      }
    },
  );

program
  .command("repoint")
  .description(
    "Per-cluster: rewrite page_info so each cluster references the NEW images " +
      "from an upload mapping CSV. DRY-RUN by default (preview + backup, no write); " +
      "pass --apply to actually PUT.",
  )
  .requiredOption("--csv <path>", "upload mapping CSV (output of the `upload` command)")
  .option(
    "--token-file <path>",
    "file holding a FRESH bearer token (1h TTL). Default: ~/.gushwork_token. Only needed with --apply.",
  )
  .option("--apply", "actually PUT the new page_info (default: dry-run only)", false)
  .option("--out <path>", "report CSV output path (default: alongside the input CSV)")
  .option("--base-url <url>", "override the API base (default: prod seo-v2 project base)")
  .option("--fail-fast", "abort the whole run on the first skipped/failed cluster", false)
  .option("--concurrency <n>", "parallel clusters", "4")
  .action(
    async (opts: {
      csv: string;
      tokenFile?: string;
      apply: boolean;
      out?: string;
      baseUrl?: string;
      failFast: boolean;
      concurrency: string;
    }) => {
      try {
        // Token is only required for a real write. Dry-run needs no API.
        const token = opts.apply ? await loadTokenOrExit(opts.tokenFile) : "";
        const concurrency = Math.max(1, Number.parseInt(opts.concurrency, 10) || 4);
        await runRepoint({
          csvPath: opts.csv,
          token,
          baseUrl: opts.baseUrl,
          apply: Boolean(opts.apply),
          failFast: Boolean(opts.failFast),
          concurrency,
          outPath: opts.out,
        });
      } catch (err) {
        process.stderr.write(
          `repoint failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
        await closePool();
      }
    },
  );

program
  .command("revert")
  .description(
    "Restore a cluster's page_info from a repoint backup. DRY-RUN by " +
      "default; --apply to PUT. Snapshots current page_info first so the " +
      "revert is itself reversible.",
  )
  .option("--file <path>", "revert exactly this backup JSON (out/repoint-backups/<cid>-<stamp>.json)")
  .option("--cluster <id>", "revert the LATEST backup for this cluster id")
  .option("--all", "revert the latest backup for every cluster in the backups dir", false)
  .option("--apply", "actually PUT the prior page_info (default: dry-run only)", false)
  .option("--token-file <path>", "fresh bearer token file (only needed with --apply). Default: ~/.gushwork_token")
  .option("--backups-dir <path>", "where repoint backups live (default: out/repoint-backups)")
  .option("--out <path>", "report CSV output path")
  .option("--base-url <url>", "override the API base")
  .option("--fail-fast", "abort on the first failed/skipped revert", false)
  .option("--concurrency <n>", "parallel reverts", "4")
  .action(
    async (opts: {
      file?: string;
      cluster?: string;
      all: boolean;
      apply: boolean;
      tokenFile?: string;
      backupsDir?: string;
      out?: string;
      baseUrl?: string;
      failFast: boolean;
      concurrency: string;
    }) => {
      try {
        const token = opts.apply ? await loadTokenOrExit(opts.tokenFile) : "";
        const concurrency = Math.max(1, Number.parseInt(opts.concurrency, 10) || 4);
        await runRevert({
          file: opts.file,
          cluster: opts.cluster,
          all: Boolean(opts.all),
          apply: Boolean(opts.apply),
          token,
          baseUrl: opts.baseUrl,
          backupsDir: opts.backupsDir,
          concurrency,
          failFast: Boolean(opts.failFast),
          outPath: opts.out,
        });
      } catch (err) {
        process.stderr.write(
          `revert failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
        await closePool();
      }
    },
  );

program
  .command("web")
  .description("Start the web UI for picking clusters + triggering regen runs.")
  .option("--port <n>", "port to bind (defaults to $PORT or 3000)")
  .action((opts: { port?: string }) => {
    // Honour the platform-supplied PORT env var (Railway, Render, Fly,
    // Heroku, etc. all inject one). Fall back to 3000 for local use.
    const fromFlag = opts.port ? Number.parseInt(opts.port, 10) : NaN;
    const fromEnv = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : NaN;
    const port = Math.max(1, Number.isFinite(fromFlag) ? fromFlag : Number.isFinite(fromEnv) ? fromEnv : 3000);
    startWebServer(port);
  });

program.parseAsync(process.argv).catch(async (err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  await closePool();
  process.exit(1);
});
