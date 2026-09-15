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
 * number, a pull-request URL, or a 40-hex `head_sha`. Use a single PR identity
 * when possible: a link to a different PR in a comment body cannot close the
 * notification's own loop. Ambiguous PR references leave the loop live.
 */

export interface ExtractedKey {
  keyKind: string;
  keyValue: string;
}

/** Senders whose mail we treat as GitHub CI/notification traffic. */
const GITHUB_NOTIFICATION_DOMAINS = ["github.com"];

const HEAD_SHA_RE = /\b[0-9a-f]{40}\b/gi;

export function isGithubNotificationSender(from: string | null | undefined): boolean {
  const address = parseEmailAddress(from);

  if (!address) return false;
  const domain = address.split("@")[1];

  return domain !== undefined && GITHUB_NOTIFICATION_DOMAINS.includes(domain);
}

/**
 * Pull the email's GitHub object key. The subject owns a PR identity when it
 * names one; otherwise Actions mail can use its existing head-sha path. A body
 * PR reference is used only when it is the sole PR identity in that body.
 * Pure and deterministic: no network and no model.
 */
export function extractGithubKeys(input: {
  subject?: string | null;
  content?: string | null;
}): ExtractedKey[] {
  const haystack = `${input.subject ?? ""}\n${input.content ?? ""}`;
  const seen = new Set<string>();
  const keys: ExtractedKey[] = [];

  const addKey = (keyKind: string, keyValue: string) => {
    const identity = `${keyKind}\u0000${keyValue}`;

    if (seen.has(identity)) return;
    seen.add(identity);
    keys.push({ keyKind, keyValue });
  };

  const subjectRef = deriveLoopEntityRef(input.subject);

  if (subjectRef?.provider === "github") {
    if (subjectRef.kind !== "pull_request") return [];

    const separator = subjectRef.id.lastIndexOf("#");
    const repoFullName = subjectRef.id.slice(0, separator);
    const number = Number(subjectRef.id.slice(separator + 1));
    const url = canonicalizeGithubPullRequestUrl({ repoFullName, number });

    if (url) addKey("pull_request_url", url);

    return keys;
  }

  const subjectUrls = collectGithubPullRequestUrls(input.subject ?? "");

  if (subjectUrls.length > 0) {
    // Two PRs in one subject is an ambiguous identity; neither one may close
    // the notification's loop.
    if (subjectUrls.length === 1) {
      for (const url of subjectUrls) addKey("pull_request_url", url);
    }

    return keys;
  }

  for (const match of haystack.matchAll(HEAD_SHA_RE)) {
    const sha = match[0].toLowerCase();

    addKey("head_sha", sha);
  }

  if (keys.length > 0) return keys;

  const bodyUrls = collectGithubPullRequestUrls(input.content ?? "");

  if (bodyUrls.length === 1) {
    for (const url of bodyUrls) addKey("pull_request_url", url);
  }

  return keys;
}
