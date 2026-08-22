import { promises as fs, createWriteStream } from "node:fs";
import path from "node:path";
import { stringify } from "csv-stringify";

export const CSV_HEADER = [
  "image_id",
  "asset_type",
  "cluster_id",
  "page_topic",
  "image_url_new",
  "image_local_path",
  "description_used",
  "prompt_used",
  "aspect_ratio",
  "generated_at_utc",
  "status",
  "error",
  "client_slug",
  "project_id",
  // The CDN URL of the IMAGE THIS RUN IS REPLACING — captured at the
  // moment the run starts (from media_registry / page_info.thumbnail
  // / MDX fallback). Lets the runs-page Compare modal show old-vs-new
  // without a separate DB round-trip.
  "previous_image_url",
  // Replicate prediction id. Captured for BOTH successful and failed
  // rows so a later regenerate can opportunistically resume the
  // original prediction (predictions often finish on Replicate's side
  // after our polling budget expires).
  "prediction_id",
  // Which upstream produced this image: "replicate" for the primary
  // Replicate nano-banana-pro path, "fal" when the E003 fallback in
  // generate.ts kicked in. Empty for failed/mocked rows. Powers the
  // per-image cost pill + run-level total in the UI, and lets us
  // audit style drift after the fact.
  "provider",
  // Per-image USD cost at time of generation, from src/pricing.ts.
  // "0" for failed / mocked / dry-run rows so a sum across the run
  // isn't polluted by retries that Replicate/fal didn't bill for.
  "cost_usd",
  // Which specific model produced this image — distinguishes the
  // two Replicate paths (nano-banana-pro vs nano-banana-2) that
  // both report provider="replicate" but bill at very different
  // rates (~4× spread). Absent for failed / mock / upload-only rows.
  "model",
  // Attribution across the 3-layer chain (flex | replicate | fal).
  // Broader than `provider` because "flex" is Google-direct, not one
  // of the historical provider enums. Empty for rows that predate
  // the 2026-08-22 Flex rollout.
  "route",
  // For route="flex" only: how long the Flex call took to return
  // successfully (ms). Empty otherwise. Powers /stats/flex latency
  // aggregates that need a per-image, not per-attempt, view.
  "flex_elapsed_ms",
  // For route="flex" only: "success" or "503_retried_success".
  // Empty otherwise. A "503_retried_success" here means Flex's first
  // attempt hit sheddable capacity and the single-retry saved us
  // from falling through to the pricier Replicate tier.
  "flex_outcome",
] as const;

export type CsvHeader = (typeof CSV_HEADER)[number];
export type CsvRow = Record<CsvHeader, string>;

export interface CsvWriter {
  write(row: Partial<CsvRow>): Promise<void>;
  close(): Promise<void>;
  path: string;
}

export async function openCsv(filePath: string): Promise<CsvWriter> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const stream = createWriteStream(filePath, { flags: "w" });
  const stringifier = stringify({ header: true, columns: [...CSV_HEADER] });
  stringifier.pipe(stream);

  return {
    path: filePath,
    // Accept Partial<CsvRow> so callers that predate a new column
    // (e.g. the 2026-08-22 flex_* additions in uploadGenerate.ts /
    // uploadRun.ts) still compile; missing keys are coerced to "" here.
    write(row: Partial<CsvRow>): Promise<void> {
      const filled: Record<CsvHeader, string> = Object.fromEntries(
        CSV_HEADER.map((k) => [k, row[k] ?? ""]),
      ) as Record<CsvHeader, string>;
      return new Promise((resolve, reject) => {
        const ok = stringifier.write(filled, (err) => (err ? reject(err) : resolve()));
        if (!ok) stringifier.once("drain", () => resolve());
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        stringifier.end(() => {
          stream.on("close", resolve);
          stream.on("error", reject);
        });
      });
    },
  };
}
