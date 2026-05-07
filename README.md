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
#      REPLICATE_API_TOKEN, FAL_KEY (optional),
#      AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY  (for S3 reads + applies)
```

Allow-list lives in [src/clients.ts](src/clients.ts). Adding a new client
is a code change there.

## Deploy on Railway

Connect this repo as a Railway service. Railway picks up `railway.json`
and uses `npm ci` to install + `npm start` to launch — which boots the
web UI on `process.env.PORT`. No build step needed (we run TypeScript
directly via `tsx`).

Required env vars to set in the Railway service:

| key                       | source                                                    |
|---------------------------|-----------------------------------------------------------|
| `DATABASE_URL`            | `gw_stormbreaker` read-only DSN                           |
| `FIRECRAWL_API_KEY`       | Firecrawl dashboard                                       |
| `PORTKEY_API_KEY`         | Portkey dashboard                                         |
| `PORTKEY_CONFIG_ID`       | optional, defaults to `pc-portke-0dd3de`                  |
| `REPLICATE_API_TOKEN`     | only required when running live (non-mock) regens         |
| `AWS_ACCESS_KEY_ID`       | reads `gw-stormbreaker/page_data/...` and writes `gw-content-store/...` |
| `AWS_SECRET_ACCESS_KEY`   | (same)                                                    |
| `AWS_REGION`              | optional, defaults to `us-east-1`                         |
| `S3_BUCKET`               | optional, defaults to `gw-stormbreaker` (placeholders fetch) |
| `S3_CONTENT_BUCKET`       | optional, defaults to `gw-content-store` (apply-to-S3 target) |
| `IMAGE_PROVIDER`          | optional, defaults to `replicate`                         |

After the first deploy, hit the Railway-assigned domain → home page
loads. The dropdown shows the allow-listed clients and you can run a
mock dry-run end-to-end. Live image generation requires
`REPLICATE_API_TOKEN`; "Apply to S3" requires the AWS keys.

**Persistence note**: Railway containers are ephemeral on redeploy.
The `graphic-tokens/<slug>.json` and `graphic-tokens/<slug>-brand.txt`
files don't survive redeploys. If that becomes a problem, attach a
Railway Volume mounted at `/app/graphic-tokens`, or move those reads
to S3 (next iteration).

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

## Data-source map (where each input field comes from)

The CLI never reads from S3. Descriptions, asset types, and `image_id`
S3 keys all live as JSONB on the `clusters` table. S3 is the
**write-target** for the downstream PM, not a read source for this CLI.

| field                  | source                                            |
|------------------------|---------------------------------------------------|
| inline image desc      | `clusters.page_info.images[i].description`        |
| inline asset_type      | `clusters.page_info.images[i].image_type`         |
| inline image S3 key    | `clusters.page_info.images[i].image_id`           |
| inline aspect hint     | `clusters.page_info.images[i].context`            |
| cover description      | `clusters.topic` (the blog post title)            |
| thumbnail description  | `clusters.topic` (same as cover)                  |
| business_context       | `projects.additional_info`                        |
| company_info           | `projects.company_info`                           |
| primary logo URL       | `projects.logo_urls.primary_logo` (parse JSONB)   |
| graphic_token          | derived live: Firecrawl(homepage_url) → Claude    |
|                        | extract_graphic_token (markdown+branding); OR     |
|                        | `./graphic-tokens/<slug>.json` with `--use-saved-token` |

**Cover and thumbnail rows are NOT in `cluster.page_info.images[]`** —
they're synthesised from `cluster.topic`, one of each per cluster. The
CSV's `image_id` for those rows uses the synthetic stable identifier
`cover-images/<cluster_id>` / `thumbnail-images/<cluster_id>` unless
`page_info` itself stores a real S3 key (`cover_image_id`,
`thumbnail_image_id`, `page_info.cover.image_id`, etc.) — in which case
the parser prefers the real key. Run `inspect-page-info` to confirm
which path applied for any cluster.

**Firecrawl markdown is never cached.** `extract-token` re-scrapes the
client homepage on every call — clients update their websites and we
want the current branding. `graphic-tokens/<slug>.json` is the only
deliberate caching layer.

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
