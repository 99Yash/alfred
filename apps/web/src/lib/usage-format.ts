// Cost and token formatters shared by the chat usage line and the Usage page, so they agree.

/** USD, with more decimals for small amounts. */
export function formatCost(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;

  if (usd >= 0.01) return `$${usd.toFixed(3)}`;

  if (usd > 0) return `$${usd.toFixed(5)}`;

  return "$0.00";
}

/** `formatCost`'s thresholds as `Intl.NumberFormat` options, for `NumberFlow`. */
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
