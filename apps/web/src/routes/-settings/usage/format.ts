/** Re-exported so the feature imports from one `./format`. */
export { formatCost, formatTokens } from "~/lib/usage-format";

const DATE_TIME_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** "Jul 18, 3:04 PM" locally; empty if unparseable. */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);

  if (Number.isNaN(d.getTime())) return "";

  return DATE_TIME_FMT.format(d);
}
