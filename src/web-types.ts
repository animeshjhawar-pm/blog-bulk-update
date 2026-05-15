/**
 * Shared types extracted from web.ts so other modules (notably
 * src/apply.ts) can consume them without depending on the rest of
 * the web server. Keep this file small and import-cheap — anything
 * runtime-heavy belongs back in web.ts.
 */

export interface CsvRowParsed {
  image_id: string;
  asset_type: string;
  cluster_id: string;
  page_topic: string;
  image_url_new: string;
  image_local_path: string;
  description_used: string;
  prompt_used: string;
  aspect_ratio: string;
  generated_at_utc: string;
  status: string;
  error: string;
  client_slug: string;
  project_id: string;
  /** CDN URL of the image this run is replacing. Captured at run-start
   * from page_info / media_registry. Older CSVs from before this
   * column existed will have it undefined; we fall back to a
   * media_registry batch lookup in that case. */
  previous_image_url?: string;
  /** Replicate prediction id from this row's generation attempt
   * (set for both successful and failed rows). Lets a later
   * regenerate poll-and-recover instead of paying for a fresh call.
   * Undefined for rows from CSVs written before this column existed. */
  prediction_id?: string;
}
