import {
  canonicalizeGithubPullRequestUrl,
  collectGithubPullRequestUrls,
  deriveLoopEntityRef,
  parseEmailAddress,
} from "@alfred/contracts";

/**
 * Deterministic key extraction (ADR-0062 v1; ADR-0063 is the rich replacement).
 *
 * GitHub notifications identify a PR through the subject's repository + PR
 * number, a pull-request URL, a 40-hex `head_sha`, or the abbreviated sha that
 * Actions failure mail carries in its subject. Use a single PR identity when
 * possible: a link to a different PR in a comment body cannot close the
 * notification's own loop. Ambiguous PR references leave the loop live.
 */

/**
 * How the store must compare a candidate value against the stored key. `prefix`
 * exists for an abbreviated sha: the value is a leading fragment of the stored
 * 40-hex key, so an exact lookup can never find it.
 */
export type ObjectKeyMatch = "exact" | "prefix";

export interface ExtractedKey {
  keyKind: string;
  keyValue: string;
  match: ObjectKeyMatch;
}

/** Senders whose mail we treat as GitHub CI/notification traffic. */
const GITHUB_NOTIFICATION_DOMAINS = ["github.com"];

const HEAD_SHA_RE = /\b[0-9a-f]{40}\b/gi;

/**
 * Shortest abbreviation that may name a commit. Git's default and GitHub's mail
 * both use 7 hex; below that a fragment is a guess, not an identity. The store
 * repeats this floor, because a shorter prefix that happens to match one row
 * would close a loop on almost no evidence.
 */
export const MIN_ABBREVIATED_SHA_LENGTH = 7;

/**
 * The abbreviated sha an Actions failure mail carries, for example
 * `[owner/repo] Run failed: ... (efd2e98)`. Only the parenthesized form counts:
 * a bare 7-hex run also spells ordinary words (`defaced`, `effaced`), and the
 * trailing parentheses are where GitHub writes the commit.
 */
const SUBJECT_ABBREVIATED_SHA_RE = new RegExp(
  String.raw`\(([0-9a-f]{${MIN_ABBREVIATED_SHA_LENGTH},40})\)`,
  "gi",
);

export function isGithubNotificationSender(from: string | null | undefined): boolean {
  const address = parseEmailAddress(from);

  if (!address) return false;
  const domain = address.split("@")[1];

  return domain !== undefined && GITHUB_NOTIFICATION_DOMAINS.includes(domain);
}

/**
 * Pull the email's GitHub object key. The subject owns a PR identity when it
 * names one; otherwise Actions mail uses a head-sha path — the full 40-hex form
 * anywhere in the mail, or the abbreviation in its own subject. A body PR
 * reference is used only when it is the sole PR identity in that body. Pure and
 * deterministic: no network and no model.
 */
export function extractGithubKeys(input: {
  subject?: string | null;
  content?: string | null;
}): ExtractedKey[] {
  const haystack = `${input.subject ?? ""}\n${input.content ?? ""}`;
  const seen = new Set<string>();
  const keys: ExtractedKey[] = [];

  const addKey = (keyKind: string, keyValue: string, match: ObjectKeyMatch) => {
    const identity = [keyKind, keyValue, match].join("\u0000");

    if (seen.has(identity)) return;
    seen.add(identity);
    keys.push({ keyKind, keyValue, match });
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

  // One abbreviation in the subject names the failed run's own commit. Two is
  // an ambiguous identity, so neither may close the loop.
  const abbreviated = collectSubjectAbbreviatedShas(input.subject ?? "");
  const onlyAbbreviated = abbreviated.length === 1 ? abbreviated[0] : undefined;

  if (onlyAbbreviated) addKey("head_sha", onlyAbbreviated, "prefix");

  for (const match of haystack.matchAll(HEAD_SHA_RE)) {
    const sha = match[0].toLowerCase();

    addKey("head_sha", sha, "exact");
  }

  if (keys.length > 0) return keys;

  const bodyUrls = collectGithubPullRequestUrls(input.content ?? "");

  if (bodyUrls.length === 1) {
    for (const url of bodyUrls) addKey("pull_request_url", url, "exact");
  }

  return keys;
}

/** Every distinct parenthesized sha abbreviation the subject carries. */
function collectSubjectAbbreviatedShas(subject: string): string[] {
  const found = new Set<string>();

  for (const match of subject.matchAll(SUBJECT_ABBREVIATED_SHA_RE)) {
    const sha = match[1]?.toLowerCase();

    if (sha) found.add(sha);
  }

  return [...found];
}
