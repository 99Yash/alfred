// Shared string helpers. Keep these pure and presentation-only — anything that
// needs locale/timezone awareness belongs with its domain hook, not here.

/** "foo" → "Foo". Empty strings pass through untouched. */
export function capitalize(value: string): string {
  return value.length > 0 ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

/** "Foo" → "foo". Empty strings pass through untouched. */
export function lowerFirst(value: string): string {
  return value.length > 0 ? value.charAt(0).toLowerCase() + value.slice(1) : value;
}

/**
 * ISO timestamp → coarse "5m ago" / "3h ago" / "2d ago". Returns the raw input
 * when it isn't a parseable date.
 */
export function formatRelative(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / (60 * 1000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
