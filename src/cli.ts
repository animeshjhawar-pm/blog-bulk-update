#!/usr/bin/env node
import { Command, Option } from "commander";
import { loadEnvOrExit } from "./env.js";
import { closePool, lookupProjectById } from "./db.js";
import { runExtractTokenCli } from "./extractToken.js";
import { runRegen } from "./regen.js";
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
  .addOption(
    new Option("--page-type <type>", "which page_type to regen for the client").choices(["blog", "service", "category"]).default("blog"),
  )
  .option("--mock", "skip Portkey + image generation; emit synthetic prompts and picsum.photos URLs (UX validation, no API spend)", false)
  .addOption(
    new Option("--provider <name>", "override IMAGE_PROVIDER").choices(["replicate", "fal"]),
  )
  .option("--concurrency <n>", "parallel image generations", "5")
  .action(
    async (opts: {
      client: string;
      dryRun: boolean;
      useSavedToken: boolean;
      assetTypes?: string;
      clusterIds?: string;
      imageIds?: string;
      pageType?: "blog" | "service" | "category";
      mock?: boolean;
      provider?: Provider;
      concurrency: string;
    }) => {
      requireKnownClient(opts.client);
      try {
        const assetTypes = parseAssetTypes(opts.assetTypes);
        const clusterIds = parseClusterIds(opts.clusterIds);
        const imageIds = parseClusterIds(opts.imageIds); // same comma-split semantics
        const concurrency = Math.max(1, Number.parseInt(opts.concurrency, 10) || 5);

        await runRegen({
          client: opts.client,
          dryRun: Boolean(opts.dryRun),
          useSavedToken: Boolean(opts.useSavedToken),
          assetTypes,
          clusterIds,
          imageIds,
          pageType: opts.pageType ?? "blog",
          mock: Boolean(opts.mock),
          provider: opts.provider,
          concurrency,
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
