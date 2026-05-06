# blog-image-regen

Regenerate every blog-page image (cover, thumbnail, every entry in
`page_info.images[]`) for a hardcoded short list of clients in the
`gw_stormbreaker` Postgres DB. Emits a per-image CSV plus a static HTML
review page. The receiving PM uses the CSV to bulk-replace images at
their existing S3 keys (`generated-images/<uuid>`).

Prompts are locked-in copies from
[imagegen-playground](https://github.com/animeshjhawar-pm/imagegen-playground).
This repo does not iterate on prompts.

## Setup

```
npm install
cp .env.example .env.local
# fill DATABASE_URL, FIRECRAWL_API_KEY, PORTKEY_API_KEY, PORTKEY_CONFIG_ID,
#      REPLICATE_API_TOKEN, FAL_KEY (optional)
```

Allow-list lives in [src/clients.ts](src/clients.ts). Adding a new client
is a code change there.

## Commands

```
# 1. Sanity-check the page_info shape for one cluster — run this FIRST
#    on a new client to confirm cover/thumbnail location.
npm run inspect-page-info -- --client sentinel-asset-management --limit 1

# 2. (Mode A — default) Auto graphic_token: scrape + extract on every run,
#    in-memory only.
npm run regen -- --client sentinel-asset-management

# 3. (Mode B) Editable graphic_token: extract once, edit, reuse.
npm run extract-token -- --client sentinel-asset-management
$EDITOR graphic-tokens/sentinel-asset-management.json
npm run regen -- --client sentinel-asset-management --use-saved-token

# Filters (combinable)
npm run regen -- --client sentinel-asset-management --asset-types cover,thumbnail
npm run regen -- --client sentinel-asset-management --cluster-ids abc-123,def-456
npm run regen -- --client sentinel-asset-management --dry-run
npm run regen -- --client sentinel-asset-management --provider fal
```

## Output

For each `regen` run:

- `out/<slug>-<utc>.csv` — one row per image. Columns, in order:
  `image_id, asset_type, cluster_id, page_topic, image_url_new,
  image_local_path, description_used, prompt_used, aspect_ratio,
  generated_at_utc, status, error, client_slug, project_id`.
  `image_id` is column 1 because that's the field the receiving PM keys
  on for the S3 replace.
- `out/<slug>-<utc>.html` — side-by-side review gallery (pure HTML +
  inline CSS, no JS framework). Open in any browser; copy buttons for
  `image_id` and `image_url_new`.
- `out/images/<slug>/<safe-image-id>.<ext>` — local copy of every
  generated image. Replicate / fal URLs expire in ~24h; the local copy
  is the safety net.
- `out/manifest-<utc>.json` — run config + final summary
  `{ ok, failed, dry_run }`.

`status` is `completed` / `failed` / `dry-run`. On failure the row is
still emitted with `error` populated; the run never aborts mid-flight.

## What it does not do

- Does not write back to `clusters.page_info` or push to S3 — the PM
  does that manually after reviewing the HTML report.
- No "any client" mode. The hardcoded list in `src/clients.ts` is the
  allow-list.
- No retries beyond what Replicate's SDK / `fal.subscribe` already do.

## Troubleshooting

- **DB unauthorized.** Test with `psql "$DATABASE_URL" -c 'SELECT 1'`.
- **Replicate timeout on `gpt-image-2`.** Set `IMAGE_PROVIDER=fal` (and
  `FAL_KEY`) and re-run; fal.ai's gpt-image-2 endpoint is faster.
- **Prompt safety refusal.** Replicate's nano-banana-pro refuses prompts
  containing `AI`, `generated`, `model`, `synthesis`, or
  `remove watermark`. The prompts in `src/prompts/` already comply —
  don't reintroduce these triggers.
- **Cover/thumbnail missing.** Run `inspect-page-info` and confirm the
  shape matches one of the resolvers in `src/pageInfo.ts`. If
  `source` shows `synthetic-cover` / `synthetic-thumbnail`, the cluster
  has no stored cover key and the run will produce a fresh one keyed at
  `cover-images/<cluster_id>` / `thumbnail-images/<cluster_id>`.
