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
 * The GitHub object-state adapter (ADR-0062 v1; ADR-0063 is the rich
 * replacement) — GitHub's irreducible half of reconciliation (#1088).
 *
 * GitHub notifications identify a PR through the subject's repository + PR
 * number, a pull-request URL, a 40-hex `head_sha`, or the abbreviated sha that
 * Actions failure mail carries in its subject. Use a single PR identity when
 * possible: a link to a different PR in a comment body cannot close the
 * notification's own loop. Ambiguous PR references leave the loop live.
 *
 * An Actions failure notification additionally names a CI TARGET — the
 * reconciled `owner/repo#branch` identity whose state is the outcome of the
 * latest suite on that branch (#1093) — through the same subject grammar, so a
 * later green run closes the ask the failure mail opened.
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
 * both use 7 hex; below that a fragment is a guess, not an identity. Read off
 * the registry's `prefixableKeys` beside the closure policy — the store reads
 * the same entry for its prefix lookup, so the two floors cannot drift.
 */
const MIN_ABBREVIATED_SHA_LENGTH = INTEGRATION_OBJECT_DEFS.github.prefixableKeys.head_sha;

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

/**
 * Whether the sender is GitHub traffic by domain. Module-private: the gated
 * extraction below is the only caller, and the name deliberately differs from
 * triage's `isGithubNotificationSender` — that one matches the
 * `notifications@github.com` address, this one gates the whole `github.com`
 * sender domain (so `noreply@github.com` passes here and fails there).
 */
function isGithubSenderDomain(from: string | null | undefined): boolean {
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
 * model. Module-private: callers go through the adapter's `proposeKeys`, which
 * applies the sender-domain gate first — this raw extraction alone would let
 * any spoofed mail propose a loop-closing identity.
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

  const bodyUrls = collectGithubPullRequestUrls(input.content);

  if (bodyUrls.length === 1) {
    for (const url of bodyUrls) addKey("pull_request_url", url, "exact");

    return keys;
  }

  // One abbreviation in the subject names the failed run's own commit. Two is
  // an ambiguous identity, so neither may close the loop.
  const abbreviated = collectSubjectAbbreviatedShas(input.subject);
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
 * The CI target an Actions failure notification is ABOUT, read from the
 * notification's own structured subject — GitHub writes
 * `[owner/repo] Run failed: <workflow> - <branch> (<sha>)`.
 *
 * The reconciled identity is the TARGET (`owner/repo#branch`), never the suite
 * attempt: a later green run on the branch closes the ask an earlier failure
 * opened, and a later failure reopens it (#1093). The reducer writes that row
 * (item 04); this is its first reader.
 *
 * The trailing `(<sha>)` is an ANCHOR, not a key — it is what makes the subject
 * unmistakably GitHub's failure notification, so an ordinary
 * `[owner/repo] Title - word` subject never matches. The abbreviation it carries
 * is proposed separately by {@link extractGithubKeys}. The `.*` before the
 * separator is greedy so the LAST ` - ` wins when the workflow name itself
 * carries one; a branch name has no spaces, so `\S+` captures it whole.
 *
 * Fail closed: no match, an unparseable repo/branch, or a branch the contract
 * canonicalizer refuses proposes nothing — absence never closes (ADR-0048-D).
 */
const GITHUB_CI_TARGET_SUBJECT_RE =
  /\[([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\][^\n]*\bRun failed:.*\s-\s(\S+)\s*\([0-9a-f]{7,40}\)\s*$/i;

/** The CI target the subject names, as one exact key, or nothing. */
function subjectCiTargetIds(subject: string): ExtractedKey[] {
  const match = GITHUB_CI_TARGET_SUBJECT_RE.exec(subject);

  if (!match?.[1] || !match[2]) return [];

  const targetId = canonicalizeGithubTargetId({ repoFullName: match[1], branch: match[2] });

  if (!targetId) return [];

  return [{ keyKind: "ci_target", keyValue: targetId, match: "exact" }];
}

/** One subject's whole text, as the un-gated readings scan it. */
function wholeText(text: SubjectText): string {
  return `${text.subject}\n${text.content}`;
}

/** Every pull request the text names, as canonical exact keys. */
function pullRequestUrlKeys(text: string): ExtractedKey[] {
  return collectGithubPullRequestUrls(text).map((url) => ({
    keyKind: "pull_request_url",
    keyValue: url,
    match: "exact",
  }));
}

/**
 * GitHub's adapter. The three readings differ in what they are allowed to
 * assume, not in how safe they are:
 *
 * - `about` requires the `github.com` sender-domain gate and returns the mail's own
 *   work-object identity — its single PR reference, or the CI target an Actions
 *   failure subject names — because the briefing uses it to DROP an item and a
 *   wrong identity would drop the wrong one.
 * - `mentions` returns every pull request the text names, with no provenance
 *   demand, because its caller SUPPRESSES a composed sentence. The canonical
 *   URL is the only written form that survives: a bare `head_sha` in arbitrary
 *   prose is a commit, not a claim about a pull request, and silencing a real
 *   ask over a coincidence costs a human a message they needed.
 * - `annotates` returns the same pull requests PLUS every full 40-hex
 *   `head_sha` the text holds. Its caller only decorates evidence it already
 *   has, so a sha that resolves to the pull request carrying it is a useful
 *   annotation and a sha that resolves to nothing costs nothing. Only the full
 *   form counts: indexed text holds hashes of many kinds, so an abbreviated
 *   prefix there is a coincidence magnet rather than an identity.
 */
export const githubObjectStateAdapter: ObjectStateAdapter = {
  provider: "github",
  proposeKeys(subject: ReconcileSubject, proposal: KeyProposal): ExtractedKey[] {
    if (proposal.reading === "mentions") return pullRequestUrlKeys(wholeText(subject.text));

    if (proposal.reading === "annotates") {
      const text = wholeText(subject.text);

      // A repeated sha needs no dedup here: `reconcileEvidence` keys every
      // candidate by `candidateIdentity` before it resolves one.
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

    // The mail's own object: the CI target its subject names (an Actions
    // failure notification's reconciled identity) ahead of the PR keys, so the
    // exact target outranks the abbreviated-sha fallback that follows.
    return [...subjectCiTargetIds(subject.text.subject), ...extractGithubKeys(subject.text)];
  },
};
