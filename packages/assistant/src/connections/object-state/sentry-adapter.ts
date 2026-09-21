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
 * URL by the shared reader. `short_id` is WRITTEN by the reducer (folded to
 * upper case) and READ from prose under `mentions` and `annotates` as an
 * exact key, so a document or commit message naming `ALFRED-4F` annotates the
 * stored issue. A short id looks like `<PROJECT>-<base36>`, and an
 * expression for it also matches `ADR-0062`, `UTF-8` and `COVID-19`. A false
 * key resolves to nothing and is harmless alone; the resolve is batched
 * (item 06 groups exact candidates by `(provider, keyKind)`), so every
 * short-id candidate rides one extra batched `resolveByKeys` per call plus
 * the shared `getStates`. Never proposed under `about`: that reading drops
 * briefing items, and a coincidence there is not free.
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
 * Every Sentry short id the text names, in first-seen order, deduplicated,
 * each returned UPPER-CASED. The reducer folds the stored key the same way
 * (sentry-reducer.ts), so the reader matches one stored value rather than
 * guessing the author's case — humans write `alfred-4f`.
 *
 * Case-insensitive `<PROJECT>-<base36>` with no length or charset floor: slugs
 * can be short and counters can be `8`, so no floor is safe. The pattern is a
 * coincidence magnet (`ADR-0062`, `UTF-8`, `COVID-19`) by design; a false key
 * resolves to nothing at the owning boundary (`resolveByKeys` returns no ref
 * for it, and the subject stays unannotated). Module-private: the reducer
 * reads `shortId` from the delivery payload, never from text, so this reader
 * has a single consumer.
 */
const SENTRY_SHORT_ID_RE = /\b([A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+)\b/g;

function collectSentryShortIds(text: string): string[] {
  const shortIds: string[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(SENTRY_SHORT_ID_RE)) {
    const raw = match[1];

    if (!raw) continue;
    const upper = raw.toUpperCase();

    if (seen.has(upper)) continue;
    seen.add(upper);
    shortIds.push(upper);
  }

  return shortIds;
}

function shortIdKeys(shortIds: readonly string[]): ExtractedKey[] {
  return shortIds.map((shortId) => ({ keyKind: "short_id", keyValue: shortId, match: "exact" }));
}

/**
 * Sentry's adapter. The three readings differ in what they are allowed to
 * assume, not in how safe they are:
 *
 * - `about` requires the `sentry.io` sender-domain gate and returns the mail's
 *   own issue id only when the text names exactly one, because its caller
 *   DROPS a briefing item and a wrong identity would drop the wrong one. Two
 *   issue links in one mail is an ambiguous identity, so neither is proposed.
 * - `mentions` returns every issue the text names, with no provenance demand:
 *   every issue URL plus every short id.
 * - `annotates` is identical to `mentions`. GitHub widens its own `annotates`
 *   with a commit sha because a sha names the pull request carrying it; Sentry
 *   widens with the short id because it is the form a human writes, and the
 *   caller only decorates, so a coincidence costs one absent annotation.
 */
export const sentryObjectStateAdapter: ObjectStateAdapter = {
  provider: "sentry",
  proposeKeys(subject: ReconcileSubject, proposal: KeyProposal): ExtractedKey[] {
    const text = wholeText(subject.text);
    const ids = collectSentryIssueIds(text);

    if (proposal.reading !== "about") {
      return [...issueIdKeys(ids), ...shortIdKeys(collectSentryShortIds(text))];
    }

    if (!isSentrySenderDomain(proposal.sender)) return [];

    return ids.length === 1 ? issueIdKeys(ids) : [];
  },
};
