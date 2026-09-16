import {
  canonicalizeGithubPullRequestUrl,
  collectGithubPullRequestUrls,
  deriveLoopEntityRef,
  parseEmailAddress,
} from "@alfred/contracts";
import { keyIdentity } from "./adapter";
import type {
  ExtractedKey,
  KeyProposalReading,
  ObjectKeyMatch,
  ObjectStateAdapter,
  ReconcileSubject,
  SubjectText,
} from "./adapter";

/**
 * The GitHub object-state adapter (ADR-0062 v1; ADR-0063 is the rich
 * replacement) — GitHub's irreducible half of reconciliation (#1088).
 *
 * GitHub notifications identify a PR through the subject's repository + PR
 * number, a pull-request URL, a 40-hex `head_sha`, or the abbreviated sha that
 * Actions failure mail carries in its subject. Use a single PR identity when
 * possible: a link to a different PR in a comment body cannot close the
 * notification's own loop. Ambiguous PR references leave the loop live.
 *
 * Everything past the proposal is generic and lives elsewhere: `reconcile.ts`
 * resolves and ranks the candidates, the store asserts state, and the
 * registry's per-kind definition declares what closes an ask.
 */

/** Senders whose mail we treat as GitHub CI/notification traffic. */
const GITHUB_NOTIFICATION_DOMAINS = ["github.com"];

const HEAD_SHA_RE = /\b[0-9a-f]{40}\b/gi;

/**
 * Shortest abbreviation that may name a commit. Git's default and GitHub's mail
 * both use 7 hex; below that a fragment is a guess, not an identity. The store
 * enforces its own floor on the prefix lookup, because a shorter prefix that
 * happens to match one row would close a loop on almost no evidence.
 */
const MIN_ABBREVIATED_SHA_LENGTH = 7;

/**
 * The abbreviated sha an Actions failure mail carries, for example
 * `[owner/repo] Run failed: ... (efd2e98)`. GitHub writes the commit in
 * trailing parentheses, so only a parenthesized run at the end of the subject
 * counts: `Invoice (1234567) paid` is a build number mid-subject, not a
 * commit. The run must also mix digits and a–f letters — an all-letter run
 * spells ordinary words (`defaced`, `effaced`), an all-digit run spells a
 * build number or date (`20260915`) — while a real abbreviation is
 * overwhelmingly mixed. A sha-shaped word such as `(facade0)` is
 * indistinguishable from a commit and still counts; the store's uniqueness
 * floor absorbs it.
 */
const SUBJECT_ABBREVIATED_SHA_RE = new RegExp(
  String.raw`\(([0-9a-f]{${MIN_ABBREVIATED_SHA_LENGTH},40})\)\s*$`,
  "i",
);

export function isGithubNotificationSender(from: string | null | undefined): boolean {
  const address = parseEmailAddress(from);

  if (!address) return false;
  const domain = address.split("@")[1];

  return domain !== undefined && GITHUB_NOTIFICATION_DOMAINS.includes(domain);
}

/**
 * Pull the email's GitHub object key. The subject owns a PR identity when it
 * names one; otherwise the full 40-hex form anywhere in the mail wins, then a
 * body PR reference when it is the sole PR identity in that body, then the
 * abbreviation in its own subject. Pure and deterministic: no network and no
 * model.
 */
export function extractGithubKeys(input: SubjectText): ExtractedKey[] {
  const haystack = `${input.subject ?? ""}\n${input.content ?? ""}`;
  const seen = new Set<string>();
  const keys: ExtractedKey[] = [];

  const addKey = (keyKind: string, keyValue: string, match: ObjectKeyMatch) => {
    const candidate: ExtractedKey = { keyKind, keyValue, match };
    const identity = keyIdentity(candidate);

    if (seen.has(identity)) return;
    seen.add(identity);
    keys.push(candidate);
  };

  const subjectRef = deriveLoopEntityRef(input.subject);

  if (subjectRef?.provider === "github") {
    if (subjectRef.kind !== "pull_request") return [];

    const separator = subjectRef.id.lastIndexOf("#");
    const repoFullName = subjectRef.id.slice(0, separator);
    const number = Number(subjectRef.id.slice(separator + 1));
    const url = canonicalizeGithubPullRequestUrl({ repoFullName, number });

    if (url) addKey("pull_request_url", url, "exact");

    return keys;
  }

  const subjectUrls = collectGithubPullRequestUrls(input.subject ?? "");

  if (subjectUrls.length > 0) {
    // Two PRs in one subject is an ambiguous identity; neither one may close
    // the notification's loop.
    if (subjectUrls.length === 1) {
      for (const url of subjectUrls) addKey("pull_request_url", url, "exact");
    }

    return keys;
  }

  // The full 40-hex form anywhere in the mail names the commit exactly. A
  // body PR reference is used only when it is the sole PR identity in that
  // body. The subject abbreviation is a guess, so it runs last: an exact
  // identity must never lose to a prefix.
  for (const match of haystack.matchAll(HEAD_SHA_RE)) {
    const sha = match[0].toLowerCase();

    addKey("head_sha", sha, "exact");
  }

  if (keys.length > 0) return keys;

  const bodyUrls = collectGithubPullRequestUrls(input.content ?? "");

  if (bodyUrls.length === 1) {
    for (const url of bodyUrls) addKey("pull_request_url", url, "exact");

    return keys;
  }

  // One abbreviation in the subject names the failed run's own commit. Two is
  // an ambiguous identity, so neither may close the loop.
  const abbreviated = collectSubjectAbbreviatedShas(input.subject ?? "");
  const onlyAbbreviated = abbreviated.length === 1 ? abbreviated[0] : undefined;

  if (onlyAbbreviated) addKey("head_sha", onlyAbbreviated, "prefix");

  return keys;
}

/** The trailing parenthesized sha abbreviation the subject carries, if any. */
function collectSubjectAbbreviatedShas(subject: string): string[] {
  const sha = SUBJECT_ABBREVIATED_SHA_RE.exec(subject)?.[1]?.toLowerCase();

  if (!sha) return [];
  // Ordinary words and build numbers/dates are single-class runs; a real
  // abbreviation mixes digits and letters.

  if (!/[0-9]/.test(sha) || !/[a-f]/.test(sha)) return [];

  return [sha];
}

/**
 * GitHub's adapter. The two readings differ in what they are allowed to
 * assume, not in how safe they are:
 *
 * - `about` requires GitHub-notification provenance and returns the mail's own
 *   single PR identity, because the briefing uses it to DROP an item and a
 *   wrong identity would drop the wrong one.
 * - `mentions` returns every pull request the text names, with no provenance
 *   demand, because a caller uses it to annotate what it already has. The
 *   canonical URL is the only written form that survives: a bare `head_sha` in
 *   arbitrary prose is a commit, not a claim about a pull request.
 */
export const githubObjectStateAdapter: ObjectStateAdapter = {
  provider: "github",
  proposeKeys(subject: ReconcileSubject, reading: KeyProposalReading): ExtractedKey[] {
    if (reading === "mentions") {
      return collectGithubPullRequestUrls(
        `${subject.text.subject ?? ""}\n${subject.text.content ?? ""}`,
      ).map((url) => ({ keyKind: "pull_request_url", keyValue: url, match: "exact" }));
    }

    if (!isGithubNotificationSender(subject.sender)) return [];

    return extractGithubKeys(subject.text);
  },
};
