import { parseEmailAddress } from "@alfred/contracts";
import { collectSentryIssueIds } from "./sentry-issue-url";
import type {
  ExtractedKey,
  KeyProposal,
  ObjectStateAdapter,
  ReconcileSubject,
  SubjectText,
} from "./adapter";

/**
 * The Sentry object-state adapter (ADR-0062, ADR-0103, #1090) — Sentry's
 * irreducible half of reconciliation, and the second provider that proves the
 * reconciliation seam is generic.
 *
 * It owns key PROPOSAL and nothing else. `reconcile.ts` resolves and ranks the
 * candidates, the store asserts state, and the registry's per-kind definition
 * declares what closes an ask. Sentry's kind declares `closesAskOn: []`
 * (ADR-0103), so a resolution here projects and displays state and suppresses
 * nothing.
 *
 * One key kind is proposed from text: `issue_id`, read out of a Sentry issue
 * URL by the shared reader. `short_id` is WRITTEN by the reducer and is
 * deliberately not read from prose in this slice — a short id looks like
 * `ALFRED-4F`, and an expression for it also matches `ADR-0062`, `UTF-8` and
 * `COVID-19`. A false key resolves to nothing and is harmless alone, but it
 * multiplies the candidate count the resolve walks.
 */

/** Senders whose mail we treat as Sentry notification traffic. */
function isSentrySenderDomain(from: string | null | undefined): boolean {
  const address = parseEmailAddress(from);

  if (!address) return false;
  const domain = address.split("@")[1];

  if (domain === undefined) return false;

  return domain === "sentry.io" || domain.endsWith(".sentry.io");
}

/** One subject's whole text, as every reading scans it. */
function wholeText(text: SubjectText): string {
  return `${text.subject}\n${text.content}`;
}

function issueIdKeys(ids: readonly string[]): ExtractedKey[] {
  return ids.map((id) => ({ keyKind: "issue_id", keyValue: id, match: "exact" }));
}

/**
 * Sentry's adapter. The three readings differ in what they are allowed to
 * assume, not in how safe they are:
 *
 * - `about` requires the `sentry.io` sender-domain gate and returns the mail's
 *   own issue id only when the text names exactly one, because its caller
 *   DROPS a briefing item and a wrong identity would drop the wrong one. Two
 *   issue links in one mail is an ambiguous identity, so neither is proposed.
 * - `mentions` returns every issue the text names, with no provenance demand.
 * - `annotates` is identical to `mentions`. GitHub widens its own `annotates`
 *   with a commit sha because a sha names the pull request carrying it; Sentry
 *   has no constituent identifier that is safe in indexed prose, so there is
 *   nothing to widen with.
 */
export const sentryObjectStateAdapter: ObjectStateAdapter = {
  provider: "sentry",
  proposeKeys(subject: ReconcileSubject, proposal: KeyProposal): ExtractedKey[] {
    const ids = collectSentryIssueIds(wholeText(subject.text));

    if (proposal.reading !== "about") return issueIdKeys(ids);

    if (!isSentrySenderDomain(proposal.sender)) return [];

    return ids.length === 1 ? issueIdKeys(ids) : [];
  },
};
