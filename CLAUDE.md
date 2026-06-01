# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

`blog-image-regen` — single-client batch regenerator for blog/service/category page images. Reads published `clusters` from the `gw_stormbreaker` Postgres DB, builds prompts via Portkey (Claude), generates images via Replicate or fal.ai, writes a per-image CSV + static HTML review page, and optionally uploads + repoints `page_info` via the Gushwork media/seo-v2 API.

The prompts in `src/prompts/` are locked copies from the imagegen-playground repo — **do not iterate on prompts here**.

## Commands

```
npm install                  # use npm ci on Railway
npm start                    # = npm run web → boots the web UI on $PORT (or 3000)
npm run type-check           # tsc --noEmit  (alias: npm run lint)
npm run build                # tsc — only used if you need emitted JS; runtime uses tsx

# Pipeline (each is a subcommand of src/cli.ts):
npm run inspect-page-info -- --client <slug> --limit 1
npm run extract-token     -- --client <slug>
npm run regen             -- --client <slug> [--dry-run] [--mock] [--use-saved-token]
                                              [--asset-types cover,thumbnail,...]
                                              [--cluster-ids ...] [--image-ids ...]
                                              [--page-type blog|service|category[,...]]
                                              [--provider replicate|fal] [--concurrency N]
npm run upload   -- --csv out/<slug>-<utc>.csv [--token-file ~/.gushwork_token]
npm run repoint  -- --csv <upload-mapping.csv> [--apply]
npm run revert   -- (--file <backup.json> | --cluster <id> | --all) [--apply]
```

No unit-test suite exists; verification is by running `--dry-run` / `--mock` regen end-to-end and inspecting the HTML report in `out/`.

## Architecture

### Entry points
- **`src/cli.ts`** — Commander CLI, dispatches to `regen.ts` / `upload.ts` / `repoint.ts` / `revert.ts` / `extractToken.ts` / `inspectPageInfo.ts` / `web.ts`. Also accepts a raw project UUID anywhere a `--client <slug>` is expected (mirrors the web UI's live project search).
- **`src/web.ts`** (7k lines) — the long-lived web UI / workspace. `npm start` boots this. Lets operators pick clusters, trigger runs, view `/runs/<id>`, regenerate single images, and drive the upload→repoint flow. Runs are stamped with `runId` so links survive a restart.

### Pipeline stages (in order)
1. **Cluster fetch** — `db.ts :: listPublishedClusters` pulls clusters by `project_id` and `page_type`.
2. **Image record extraction** — `pageInfo.ts :: collectImageRecords` flattens each cluster's `page_info` JSONB into a list of `ImageRecord`s. Cover + thumbnail are **synthesised from `cluster.topic`** (one of each per cluster) — they are NOT in `page_info.images[]`. The resolver prefers a real stored S3 key (`cover_image_id`, `thumbnail_image_id`, `page_info.cover.image_id`, …) and falls back to `cover-images/<cluster_id>` / `thumbnail-images/<cluster_id>`. When debugging missing covers/thumbnails, run `inspect-page-info` to see which resolver path applied.
3. **Graphic token** — `extractToken.ts` + `tokens.ts`. Mode A (default): Firecrawl-scrape the project homepage on every run and run Claude `extract_graphic_token` in-memory. Mode B (`--use-saved-token`): read `graphic-tokens/<slug>.json` (the five pinned clients in `src/clients.ts` have these committed; Railway redeploys wipe everything else — see persistence note in README).
4. **Prompt build** — `buildPrompt.ts` chooses a template from `src/prompts/<asset-type>.ts`, fills via `interpolate.ts`, and renders system+user via Portkey (`portkey.ts`). `--prompt-overrides-file` lets the workspace's confirm-modal override system/user per asset group without mutating the prompt files. `--extra-instructions-file` merges a one-off addendum into the top-priority brand-directives block.
5. **Generation** — `generate.ts` dispatches to `replicate.ts` (default, `gpt-image-2` / `nano-banana-pro`) or `fal.ts`. `--resume-prediction-id` lets a single-image retry poll a prior Replicate prediction instead of spending again.
6. **Local rehost** — `rehost.ts` downloads to `out/images/<slug>/<safe-id>.<ext>` because Replicate/fal URLs expire ~24h.
7. **Reports** — `csv.ts` writes the per-image CSV (column order matters: `image_id` is column 1 because the receiving PM keys on it). `html.ts` writes the side-by-side review gallery. `runOutDir.ts` controls the `out/<slug>-<utc>/` directory layout.

### Apply / repoint pipeline (post-regen)
- **`upload.ts` + `uploadRun.ts`** — push each generated image through the Gushwork media API (presign → PUT → confirm). Emits a mapping CSV (old `image_id` → new). The repo has a `src/apply.ts` + `src/imageResize.ts` primitive that produces 3 WebP variants and writes directly to S3 (`docs/apply-api-blueprint.md` documents the gap vs. stormbreaker's lambda-driven pipeline — read this before extending apply).
- **`repoint.ts`** — per-cluster: GET current `page_info`, rewrite references to the new `image_id`s, write a backup to `out/repoint-backups/<cid>-<stamp>.json`, then PUT. Dry-run by default; needs `--apply` to actually write.
- **`revert.ts`** — replay a repoint backup. Itself snapshots current state first so revert is reversible.

### Allow-list
`src/clients.ts` is the hardcoded allow-list (currently 5 clients). Adding a client = PR adding a `{ slug, projectId }` entry. The CLI also accepts a raw project UUID — `requireKnownClient()` allows either form, which mirrors the workspace's "search any project" UX.

### Data-source rules
- The CLI **never reads images from S3**. Descriptions, asset types, and existing `image_id` S3 keys all live as JSONB on the `clusters` table. S3 is the **write target** for the downstream PM, not a read source.
- Firecrawl markdown is **never cached** — `extract-token` re-scrapes every call. `graphic-tokens/<slug>.json` is the only deliberate caching layer.

### Prompt safety
Replicate's `nano-banana-pro` refuses prompts containing the words `AI`, `generated`, `model`, `synthesis`, or `remove watermark`. Templates in `src/prompts/` already comply — don't reintroduce these triggers when editing.

### Token / auth
`upload` and `repoint --apply` need a fresh Gushwork bearer token (1h TTL) at `~/.gushwork_token` (overridable with `--token-file`). `loadTokenOrExit` in `cli.ts` rejects empty/expired tokens before the first API call. Fetch from `https://platform.gushwork.ai/api/auth/token`.

## Deploy

Railway service. `railway.json` + `nixpacks.toml` drive it; `npm ci` installs and `npm start` boots the web UI. No build step (TypeScript runs via `tsx`). Required env vars are listed in the README; key ones:
- `DATABASE_URL` (gw_stormbreaker read-only)
- `FIRECRAWL_API_KEY`, `PORTKEY_API_KEY` (+ optional `PORTKEY_CONFIG_ID`)
- `REPLICATE_API_TOKEN` (live regens) and/or `FAL_KEY`
- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` for S3 reads (placeholders bucket = `gw-stormbreaker`) and applies (content bucket = `gw-content-store`)

**Railway containers are ephemeral on redeploy** — anything written to `graphic-tokens/` or `out/` at runtime is lost. Only the committed `graphic-tokens/<slug>.json` files survive.
