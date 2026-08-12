// ---------------------------------------------------------------------------
// Per-image cost table by provider. Sourced from each provider's public
// pricing pages as of 2026-08. Only the two providers/models we
// actually route through are listed — this file is where you edit if
// pricing changes upstream.
// ---------------------------------------------------------------------------

export type PricedProvider = "replicate" | "fal";

/** USD per successful generation. Failed generations cost $0 in our
 *  cost accounting: providers don't bill for failed predictions and
 *  we don't want to distort the per-run total with retry noise. */
const UNIT_COST_USD: Record<PricedProvider, number> = {
  // google/nano-banana-pro on Replicate — 2K resolution, per prediction.
  // Documented in CLAUDE.md and Replicate's model page.
  replicate: 0.15,
  // fal-ai/nano-banana-pro on fal.ai — text-to-image + image-to-image
  // are the same headline unit price on fal's pricing page at the time
  // of writing. If they diverge, split into two rows keyed by model.
  fal: 0.039,
};

/**
 * Cost in USD for one successful generation on the given provider.
 * Returns 0 for anything unknown so a stray provider string never
 * crashes CSV serialisation or the UI sum.
 */
export function unitCostUsd(provider: string | null | undefined): number {
  if (!provider) return 0;
  const k = provider as PricedProvider;
  return UNIT_COST_USD[k] ?? 0;
}

/** Formatted USD string for display — 4 decimals so per-image fal
 *  cost ($0.0390) reads as more than $0.00. */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
}
