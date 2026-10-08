// Zone-aware formatting belongs with its domain hook, not here.

export function capitalize(value: string): string {
  return value.length > 0 ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

export function lowerFirst(value: string): string {
  return value.length > 0 ? value.charAt(0).toLowerCase() + value.slice(1) : value;
}

/** An invalid date returns the input. */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) return iso;

  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "5m ago", "3h ago", "2d ago". An invalid date returns the input. */
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
