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

  // The run CSV is the ONE file this repo deliberately does NOT write
  // atomically (everything else goes through writeFileAtomic). It can't
  // be staged: the run page streams this file WHILE the run is still
  // appending rows, so it has to exist at its final path from the first
  // row onward.
  //
  // Surfacing write errors is the safety net instead. Without a
  // listener, an ENOSPC mid-run emits 'error' on a stream nobody is
  // watching — Node's default for an unhandled stream 'error' is to
  // throw, which killed the whole run process and left the operator
  // with a half-written CSV and no explanation. With one, the failure
  // is latched and the next write()/close() rejects with the real
  // errno, so the run fails loudly and the manifest records why.
  //
  // Recovery of an already-truncated CSV is the reader's job: see
  // readRunCsv in web.ts, which drops a partial trailing row rather
  // than discarding every complete row with it.
  const state: { failure: Error | null; closed: boolean } = { failure: null, closed: false };
  const onErr = (err: Error) => { state.failure = state.failure ?? err; };
  stream.on("error", onErr);
  stringifier.on("error", onErr);
  stream.on("close", () => { state.closed = true; });
  // Rows are written CONCURRENTLY (regen.ts fans out across a limiter),
  // so many writes can be waiting on drain/close at once. Uncap the
  // listener count rather than eat a spurious MaxListenersExceeded
  // warning on every large run — each waiter removes its own listeners
  // as soon as it settles.
  stream.setMaxListeners(0);
  stringifier.setMaxListeners(0);

  return {
    path: filePath,
    // Accept Partial<CsvRow> so callers that predate a new column
    // (e.g. the 2026-08-22 flex_* additions in uploadGenerate.ts /
    // uploadRun.ts) still compile; missing keys are coerced to "" here.
    write(row: Partial<CsvRow>): Promise<void> {
      if (state.failure) return Promise.reject(state.failure);
      const filled: Record<CsvHeader, string> = Object.fromEntries(
        CSV_HEADER.map((k) => [k, row[k] ?? ""]),
      ) as Record<CsvHeader, string>;
      return new Promise<void>((resolve, reject) => {
        // Every path out of this promise has to settle it, including the
        // failure paths. The original version resolved only on the write
        // callback or on "drain" — and when the underlying stream dies
        // (ENOSPC), "drain" never fires. The await then hung forever,
        // the run stalled with no error anywhere, and once every other
        // task had finished the process exited 0 with a half-written
        // CSV and no explanation. Settling on the stream's "close" is
        // what turns that silent hang into a real rejection.
        let settled = false;
        const done = (err?: Error | null) => {
          if (settled) return;
          settled = true;
          stringifier.off("drain", onDrain);
          stream.off("close", onClosed);
          const failure = err ?? state.failure;
          if (failure) reject(failure);
          else resolve();
        };
        const onDrain = () => done();
        const onClosed = () => done();
        stringifier.once("drain", onDrain);
        stream.once("close", onClosed);
        const ok = stringifier.write(filled, (err) => done(err ?? null));
        if (ok) done();
      });
    },
    close(): Promise<void> {
      // Settle on 'close', which fires for both the clean and the
      // errored path (autoDestroy), and re-check the latched failure
      // there — the old version attached its error handler INSIDE the
      // end() callback, so a stream that had already errored and closed
      // left this promise pending forever.
      return new Promise((resolve, reject) => {
        // A stringifier error never reaches the fs stream, because pipe()
        // does not forward a source error to its destination. Waiting on
        // the stream's "close" in that case would hang exactly like the
        // bug above. Settle on an already-latched failure first.
        if (state.failure) { reject(state.failure); return; }
        const settle = () => (state.failure ? reject(state.failure) : resolve());
        if (state.closed) { settle(); return; }
        stream.once("close", settle);
        stringifier.end();
      });
    },
  };
}
