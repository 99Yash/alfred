/**
 * Deterministic key extraction (ADR-0062 v1; ADR-0063 is the rich replacement).
 *
 * A GitHub CI/notification email carries a 40-hex `head_sha` and *no* PR number
 * — so the only deterministic bridge from the email back to its PR is to pull
 * the sha and `resolveByKey('github','head_sha', sha)`. This is a legitimate
 * dumb proposer behind the stable `extractKeys` interface: a literal 40-hex
 * string is unambiguous, and even a wrong match resolves to nothing (the
 * propose/dispose invariant makes a bad key safe — it cannot fake a merge).
 */

export interface ExtractedKey {
  keyKind: string;
  keyValue: string;
}

/** Senders whose mail we treat as GitHub CI/notification traffic. */
const GITHUB_NOTIFICATION_DOMAINS = ["github.com"];

const HEAD_SHA_RE = /\b[0-9a-f]{40}\b/gi;

export function isGithubNotificationSender(from: string | null | undefined): boolean {
  if (!from) return false;
  const lower = from.toLowerCase();
  return GITHUB_NOTIFICATION_DOMAINS.some((domain) => lower.includes(`@`) && lower.includes(domain));
}

/**
 * Pull GitHub-CI candidate keys (currently `head_sha`) out of an email's text.
 * Scans subject + body; dedupes; returns `[]` when nothing matches. Pure and
 * deterministic — no network, no model.
 */
export function extractGithubKeys(input: {
  subject?: string | null;
  content?: string | null;
}): ExtractedKey[] {
  const haystack = `${input.subject ?? ""}\n${input.content ?? ""}`;
  const seen = new Set<string>();
  const keys: ExtractedKey[] = [];
  for (const match of haystack.matchAll(HEAD_SHA_RE)) {
    const sha = match[0].toLowerCase();
    if (seen.has(sha)) continue;
    seen.add(sha);
    keys.push({ keyKind: "head_sha", keyValue: sha });
  }
  return keys;
}
