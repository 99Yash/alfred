/**
 * Timestamp formatting for the usage dashboard. Cost/token formatters live in
 * `~/lib/usage-format` (shared with the chat usage line); re-exported here so
 * the feature's components keep a single `./format` import.
 */
export { formatCost, formatTokens } from "~/lib/usage-format";

const DATE_TIME_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** "Jul 18, 3:04 PM" in the viewer's locale/timezone; empty on unparseable input. */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return DATE_TIME_FMT.format(d);
}
