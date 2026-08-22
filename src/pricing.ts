// ---------------------------------------------------------------------------
// Per-image cost table by provider. Sourced from each provider's public
// pricing pages as of 2026-08. Only the two providers/models we
// actually route through are listed — this file is where you edit if
// pricing changes upstream.
// ---------------------------------------------------------------------------

export type PricedProvider = "replicate" | "fal" | "flex";

/** Per-model pricing. Preferred when the model is known — covers the
 *  two Replicate paths separately (pro is ~4× more expensive than -2),
 *  and lets fal endpoints price independently if we ever add more. */
const MODEL_COST_USD: Record<string, number> = {
  "gemini-3-pro-image-flex": 0.067, // Google Flex tier, 1K/2K image (2026-08 pricing page)
  "google/nano-banana-pro": 0.15,
  "google/nano-banana-2": 0.039, // legacy row; layer removed 2026-08-22
  "fal-nano-banana-pro": 0.039,
};

/** Fallback per-provider pricing for older CSV rows and any caller
 *  that hasn't propagated the model field yet. Assumes "replicate" =
 *  the historical primary path (nano-banana-pro), "fal" = fal
 *  nano-banana-pro fallback. */
const PROVIDER_COST_USD: Record<PricedProvider, number> = {
  replicate: 0.15,
  fal: 0.039,
  flex: 0.067,
};

/**
 * Cost in USD for one successful generation. Prefers the exact model
 * when available (accurate for the nano-banana-2 fallback layer);
 * falls back to the per-provider default for older CSV rows that
 * predate the model column. Returns 0 for anything unknown so a stray
 * string never crashes CSV serialisation or the UI sum.
 */
export function unitCostUsd(
  provider: string | null | undefined,
  model?: string | null,
): number {
  if (model && MODEL_COST_USD[model] != null) return MODEL_COST_USD[model]!;
  if (!provider) return 0;
  const k = provider as PricedProvider;
  return PROVIDER_COST_USD[k] ?? 0;
}

/** Formatted USD string for display — 4 decimals so per-image fal
 *  cost ($0.0390) reads as more than $0.00. */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0";
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
}
