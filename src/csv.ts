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
] as const;

export type CsvHeader = (typeof CSV_HEADER)[number];
export type CsvRow = Record<CsvHeader, string>;

export interface CsvWriter {
  write(row: CsvRow): Promise<void>;
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
    write(row: CsvRow): Promise<void> {
      return new Promise((resolve, reject) => {
        const ok = stringifier.write(row, (err) => (err ? reject(err) : resolve()));
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
