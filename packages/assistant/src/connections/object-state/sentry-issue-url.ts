/**
 * Reads Sentry issue ids out of free text (#1090). Keyed by numeric id, because the webhook body
 * has no org slug to build a canonical URL (`docs/research/sentry-push-surface-and-autofix.md`).
 * The adapter and the reducer share this reader so they agree on what an issue URL is.
 */

/**
 * Accepts `https://<org>.sentry.io/issues/<id>/` and
 * `https://sentry.io/organizations/<org>/issues/<id>/`, plus an optional events segment, query or
 * fragment. Self-hosted hosts are out of scope. `/issues/` must follow the host or org segment, so
 * docs pages do not match. The trailing `\b` keeps `.../issues/123abc` from reading as `123`.
 */
const SENTRY_ISSUE_URL_RE =
  /\bhttps?:\/\/(?:[A-Za-z0-9-]+\.)?sentry\.io\/(?:organizations\/[A-Za-z0-9._-]+\/)?issues\/(\d+)\b/gi;

/**
 * Issue ids the text names, deduped in first-seen order. A caller that needs one checks the length.
 */
export function collectSentryIssueIds(text: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(SENTRY_ISSUE_URL_RE)) {
    const id = match[1];

    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  return ids;
}
