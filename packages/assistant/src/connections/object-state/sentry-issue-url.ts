/**
 * The one reader of a Sentry issue identity out of free text (#1090).
 *
 * A Sentry issue is keyed by its numeric ID, not by a canonical URL. The
 * lifecycle webhook body carries no organization slug (see
 * `docs/research/sentry-push-surface-and-autofix.md`), so the reducer cannot
 * mint a canonical `https://<org>.sentry.io/…` URL the way
 * `canonicalizeGithubPullRequestUrl` mints a GitHub one. The ID alone is
 * globally unique inside Sentry, so keying on it removes the problem and lets
 * one expression accept every written form.
 *
 * Directory-private on purpose: the adapter reads it to PROPOSE a key from
 * indexed prose, and the reducer reads it to decide whether a delivery's
 * `permalink` really names the issue it is folding. Those two must not
 * disagree about what a Sentry issue URL is, so they share one reader.
 * `@alfred/contracts` gains no name — `collectGithubPullRequestUrls` lives
 * there only because the briefing pre-send guard is a second consumer outside
 * this directory, and this reader has none.
 */

/**
 * Every accepted written form of a Sentry issue link:
 *
 *   https://<org>.sentry.io/issues/<id>/
 *   https://sentry.io/organizations/<org>/issues/<id>/
 *
 * with an optional trailing `events/<event_id>/` segment, query string, or
 * fragment. The host must end in `sentry.io`, so a self-hosted install
 * (`https://sentry.example.com/issues/12/`) is out of scope rather than
 * silently keyed into the SaaS projection. `/issues/` must follow the host or
 * the `organizations/<org>/` segment directly, so a documentation page
 * (`https://docs.sentry.io/product/issues/states-triage/`) does not match. The
 * trailing `\b` keeps `…/issues/123abc` from reading as issue `123`.
 */
const SENTRY_ISSUE_URL_RE =
  /\bhttps?:\/\/(?:[A-Za-z0-9-]+\.)?sentry\.io\/(?:organizations\/[A-Za-z0-9._-]+\/)?issues\/(\d+)\b/gi;

/**
 * Every Sentry issue id the text names, in first-seen order, deduplicated.
 *
 * Pure and total — it reports what the text names and nothing more. A caller
 * that needs a SINGLE identity checks the length itself.
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
