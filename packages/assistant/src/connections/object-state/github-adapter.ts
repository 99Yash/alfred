import {
  canonicalizeGithubPullRequestUrl,
  canonicalizeGithubTargetId,
  collectGithubPullRequestUrls,
  deriveLoopEntityRef,
  INTEGRATION_OBJECT_DEFS,
  parseEmailAddress,
} from "@alfred/contracts";
import { keyIdentity } from "./adapter";
import type {
  ExtractedKey,
  KeyProposal,
  ObjectKeyMatch,
  ObjectStateAdapter,
  ReconcileSubject,
  SubjectText,
} from "./adapter";

/**
 * GitHub object-state adapter (ADR-0062 v1, #1088). Mail names a PR by subject repo and number, a
 * PR URL, a 40-hex `head_sha`, or the short sha in Actions failure subjects. Prefer one PR
 * identity: a link to another PR in a comment must not close this mail's loop. Actions failure mail
 * also names a CI target (`owner/repo#branch`), so a later green run closes it (#1093).
 */

/** Senders whose mail we treat as GitHub CI/notification traffic. */
const GITHUB_NOTIFICATION_DOMAINS = ["github.com"];

const HEAD_SHA_RE = /\b[0-9a-f]{40}\b/gi;

/**
 * 7 hex, as Git and GitHub mail use. Read from the registry, which the store's prefix lookup also
 * reads.
 */
const MIN_ABBREVIATED_SHA_LENGTH = INTEGRATION_OBJECT_DEFS.github.prefixableKeys.head_sha;

/**
 * The short sha at the end of an Actions failure subject, e.g. `Run failed: ... (efd2e98)`. Only a
 * trailing parenthesized run counts: `Invoice (1234567) paid` is a build number. It must mix digits
 * and a-f letters: `defaced` is a word, `20260915` a date.
 */
const SUBJECT_ABBREVIATED_SHA_RE = new RegExp(
  String.raw`\(([0-9a-f]{${MIN_ABBREVIATED_SHA_LENGTH},40})\)\s*$`,
  "i",
);

/**
 * Gate on the whole `github.com` domain. Unlike triage's `isGithubNotificationSender`, which
 * matches only `notifications@github.com`.
 */
function isGithubSenderDomain(from: string | null | undefined): boolean {
  const address = parseEmailAddress(from);

  if (!address) return false;
  const domain = address.split("@")[1];

  return domain !== undefined && GITHUB_NOTIFICATION_DOMAINS.includes(domain);
}

/**
 * Extract GitHub keys. Order: the subject's PR identity, then any 40-hex sha, then a sole body PR,
 * then the subject's short sha. Only `proposeKeys` calls this, after the sender gate; without the
 * gate, spoofed mail could propose a loop-closing identity.
 */
function extractGithubKeys(input: SubjectText): ExtractedKey[] {
  const haystack = `${input.subject}\n${input.content}`;
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

  const subjectUrls = collectGithubPullRequestUrls(input.subject);

  if (subjectUrls.length > 0) {
    // Two PRs in one subject is ambiguous, so neither may close the loop.
    if (subjectUrls.length === 1) {
      for (const url of subjectUrls) addKey("pull_request_url", url, "exact");
    }

    return keys;
  }

  // A full sha is exact. The short sha is a guess and runs last, so exact always wins.
  for (const match of haystack.matchAll(HEAD_SHA_RE)) {
    const sha = match[0].toLowerCase();

    addKey("head_sha", sha, "exact");
  }

  if (keys.length > 0) return keys;

  const bodyUrls = collectGithubPullRequestUrls(input.content);

  if (bodyUrls.length === 1) {
    for (const url of bodyUrls) addKey("pull_request_url", url, "exact");

    return keys;
  }

  // Two short shas in the subject is ambiguous.
  const abbreviated = collectSubjectAbbreviatedShas(input.subject);
  const onlyAbbreviated = abbreviated.length === 1 ? abbreviated[0] : undefined;

  if (onlyAbbreviated) addKey("head_sha", onlyAbbreviated, "prefix");

  return keys;
}

/** The subject's trailing short sha, if any. */
function collectSubjectAbbreviatedShas(subject: string): string[] {
  const sha = SUBJECT_ABBREVIATED_SHA_RE.exec(subject)?.[1]?.toLowerCase();

  if (!sha) return [];
  // Words and dates use one character class; a real abbreviation mixes both.

  if (!/[0-9]/.test(sha) || !/[a-f]/.test(sha)) return [];

  return [sha];
}

/**
 * The CI target of an Actions failure subject:
 * `[owner/repo] Run failed: <workflow> - <branch> (<sha>)`. The key is the target, not the run, so
 * a later green run closes the ask and a later failure reopens it (#1093). The trailing `(<sha>)`
 * is only an anchor, so `[owner/repo] Title - word` never matches. Greedy `.*` makes the last ` - `
 * win when the workflow name has one. No match or a refused branch proposes nothing (ADR-0048-D).
 */
const GITHUB_CI_TARGET_SUBJECT_RE = new RegExp(
  String.raw`\[([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\][^\n]*\bRun failed:.*\s-\s(\S+)\s*\([0-9a-f]{${MIN_ABBREVIATED_SHA_LENGTH},40}\)\s*$`,
  "i",
);

/** The subject's CI target as one exact key, or nothing. */
function subjectCiTargetIds(subject: string): ExtractedKey[] {
  const match = GITHUB_CI_TARGET_SUBJECT_RE.exec(subject);

  if (!match?.[1] || !match[2]) return [];

  const targetId = canonicalizeGithubTargetId({ repoFullName: match[1], branch: match[2] });

  if (!targetId) return [];

  return [{ keyKind: "ci_target", keyValue: targetId, match: "exact" }];
}

function wholeText(text: SubjectText): string {
  return `${text.subject}\n${text.content}`;
}

/** Every PR the text names, as canonical exact keys. */
function pullRequestUrlKeys(text: string): ExtractedKey[] {
  return collectGithubPullRequestUrls(text).map((url) => ({
    keyKind: "pull_request_url",
    keyValue: url,
    match: "exact",
  }));
}

/**
 * - `about`: needs the `github.com` sender gate. Returns the mail's own PR or CI target, because
 *   the briefing drops an item on it.
 * - `mentions`: every PR URL, no provenance. Not bare shas: a sha in prose is not a claim about a
 *   PR, and suppressing a real ask over a coincidence costs the user a message.
 * - `annotates`: PR URLs plus every full 40-hex sha. Not short shas: indexed text holds many kinds
 *   of hash.
 */
export const githubObjectStateAdapter: ObjectStateAdapter = {
  provider: "github",
  proposeKeys(subject: ReconcileSubject, proposal: KeyProposal): ExtractedKey[] {
    if (proposal.reading === "mentions") return pullRequestUrlKeys(wholeText(subject.text));

    if (proposal.reading === "annotates") {
      const text = wholeText(subject.text);

      // `reconcileEvidence` dedupes repeated shas.
      const shaKeys = [...text.matchAll(HEAD_SHA_RE)].map(
        (found): ExtractedKey => ({
          keyKind: "head_sha",
          keyValue: found[0].toLowerCase(),
          match: "exact",
        }),
      );

      return [...pullRequestUrlKeys(text), ...shaKeys];
    }

    if (!isGithubSenderDomain(proposal.sender)) return [];

    // The CI target first, so the exact target outranks the short-sha prefix.
    return [...subjectCiTargetIds(subject.text.subject), ...extractGithubKeys(subject.text)];
  },
};
