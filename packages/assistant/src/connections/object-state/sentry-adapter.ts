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
 * Sentry object-state adapter (ADR-0062, ADR-0103, #1090). Key proposal only. Sentry closes from
 * `live_confirmation`, so only a consumer with a live issue read may close. Proposes `issue_id`
 * from issue URLs, and upper-cased `short_id` from prose under `mentions` and `annotates`. The
 * short-id pattern also matches `ADR-0062` or `UTF-8`, which resolve to nothing. Never under
 * `about`, which drops briefing items.
 */

/** Sentry notification sender, by domain. */
function isSentrySenderDomain(from: string | null | undefined): boolean {
  const address = parseEmailAddress(from);

  if (!address) return false;
  const domain = address.split("@")[1];

  if (domain === undefined) return false;

  return domain === "sentry.io" || domain.endsWith(".sentry.io");
}

function wholeText(text: SubjectText): string {
  return `${text.subject}\n${text.content}`;
}

function issueIdKeys(ids: readonly string[]): ExtractedKey[] {
  return ids.map((id) => ({ keyKind: "issue_id", keyValue: id, match: "exact" }));
}

/**
 * Short ids in the text, deduped and upper-cased to match the reducer's stored key. No length
 * floor: slugs can be short and counters can be `8`. False hits resolve to nothing.
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
 * - `about`: needs the `sentry.io` sender gate, and only an exactly-one issue id, because the
 *   briefing drops an item on it.
 * - `mentions` and `annotates`: every issue URL and short id. No provenance needed.
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
