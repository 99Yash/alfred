/**
 * A date-time value for a GitHub search date qualifier (`merged:`, `created:`, `closed:`).
 * GitHub documents the `+00:00` offset form, not a `Z` suffix (ADR-0068), and the
 * `merged:` range has second precision, so the milliseconds are dropped. The GitHub MCP
 * merged read (`connections/verified-pull/github.ts`) sends it.
 */
export function githubSearchDateTime(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "+00:00");
}
