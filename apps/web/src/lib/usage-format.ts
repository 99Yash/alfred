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

/** Compact token count: 1234 → "1.2k", 3_400_000 → "3.4M", 512 → "512". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}
