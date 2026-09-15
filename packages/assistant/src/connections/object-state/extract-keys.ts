import {
  canonicalizeGithubPullRequestUrl,
  deriveLoopEntityRef,
  parseEmailAddress,
} from "@alfred/contracts";

/**
 * Deterministic key extraction (ADR-0062 v1; ADR-0063 is the rich replacement).
 *
 * GitHub notifications identify a PR through a 40-hex `head_sha`, a canonical
 * pull-request URL, or the repository + PR number in the subject. These are
 * legitimate dumb proposers behind the stable `extractKeys` interface: even a
 * wrong match resolves to nothing (the propose/dispose invariant makes a bad
 * key safe — it cannot fake a merge).
 */

export interface ExtractedKey {
  keyKind: string;
  keyValue: string;
}

/** Senders whose mail we treat as GitHub CI/notification traffic. */
const GITHUB_NOTIFICATION_DOMAINS = ["github.com"];

const HEAD_SHA_RE = /\b[0-9a-f]{40}\b/gi;

const PULL_REQUEST_URL_RE =
  /\bhttps?:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/pull\/(\d+)\b/gi;

const REPO_PULL_REQUEST_RE = /\b([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)#(\d+)\b/g;

export function isGithubNotificationSender(from: string | null | undefined): boolean {
  const address = parseEmailAddress(from);

  if (!address) return false;
  const domain = address.split("@")[1];

  return domain !== undefined && GITHUB_NOTIFICATION_DOMAINS.includes(domain);
}

/**
 * Pull GitHub candidate keys out of an email's text. Scans subject + body,
 * understands GitHub's `[owner/repo] ... (PR #123)` subject form, dedupes, and
 * returns `[]` when nothing matches. Pure and deterministic: no network and no
 * model.
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

  for (const match of haystack.matchAll(HEAD_SHA_RE)) {
    const sha = match[0].toLowerCase();

    addKey("head_sha", sha);
  }

  for (const match of haystack.matchAll(PULL_REQUEST_URL_RE)) {
    const repoFullName = match[1];
    const number = Number(match[2]);

    if (!repoFullName) continue;
    const url = canonicalizeGithubPullRequestUrl({ repoFullName, number });

    if (url) addKey("pull_request_url", url);
  }

  for (const match of haystack.matchAll(REPO_PULL_REQUEST_RE)) {
    const repoFullName = match[1];
    const number = Number(match[2]);

    if (!repoFullName) continue;
    const url = canonicalizeGithubPullRequestUrl({ repoFullName, number });

    if (url) addKey("pull_request_url", url);
  }

  const subjectRef = deriveLoopEntityRef(input.subject);

  if (subjectRef?.provider === "github" && subjectRef.kind === "pull_request") {
    const separator = subjectRef.id.lastIndexOf("#");
    const repoFullName = subjectRef.id.slice(0, separator);
    const number = Number(subjectRef.id.slice(separator + 1));
    const url = canonicalizeGithubPullRequestUrl({ repoFullName, number });

    if (url) addKey("pull_request_url", url);
  }

  return keys;
}
