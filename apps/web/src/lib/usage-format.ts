// Shared usage-economics formatters — cost (USD) and token counts. Used by
// every surface that shows what some work cost: the chat per-turn usage line
// and the settings → Usage dashboard. Presentation-only and side-effect-free;
// keep the two surfaces on one implementation so a "3.4M-token" run never
// renders as "3400.0k" in one place and "3.4M" in another.

/** Cost in USD, precision scaling with magnitude so sub-cent runs stay legible. */
export function formatCost(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;

  if (usd >= 0.01) return `$${usd.toFixed(3)}`;

  if (usd > 0) return `$${usd.toFixed(5)}`;

  return "$0.00";
}

/**
 * The `Intl.NumberFormat` fraction digits behind {@link formatCost}, for the
 * animated cost digits (`NumberFlow` takes a numeric value + format, not a
 * pre-rendered string). Same thresholds, so the flow lands on the exact
 * figures the tooltips quote.
 */
export function costFractionDigits(usd: number) {
  if (usd >= 1) return { minimumFractionDigits: 2, maximumFractionDigits: 2 };

  if (usd >= 0.01) return { minimumFractionDigits: 3, maximumFractionDigits: 3 };

  if (usd > 0) return { minimumFractionDigits: 5, maximumFractionDigits: 5 };

  return { minimumFractionDigits: 2, maximumFractionDigits: 2 };
}

/** Compact token count: 1234 → "1.2k", 3_400_000 → "3.4M", 512 → "512". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;

  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;

  return `${Math.round(n)}`;
}

/** Model output throughput, excluding tool and workflow time. */
export function outputTokensPerSecond(outputTokens: number, modelLatencyMs: number): number | null {
  if (outputTokens <= 0 || modelLatencyMs <= 0) return null;

  return outputTokens / (modelLatencyMs / 1_000);
}
