import type { ExtractedKey, KeyProposal, ObjectStateAdapter, ReconcileSubject } from "./adapter";

/**
 * Sentry object-state adapter (ADR-0062, ADR-0103, #1090). Key proposal only. Sentry closes from
 * `live_confirmation`, so only a consumer with a live issue read may close. The issue link names
 * an issue through identity containment (ADR-0109): the registry declares `issue_id` as its unique
 * key. This adapter proposes only the upper-cased `short_id` from prose under `mentions` and
 * `annotates`. The short-id pattern also matches `ADR-0062` or `UTF-8`, which resolve to nothing.
 * Never under `about`, which drops briefing items.
 */

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

/** `mentions` and `annotates`: every short id. `about`: nothing. */
export const sentryObjectStateAdapter: ObjectStateAdapter = {
  provider: "sentry",
  proposeKeys(subject: ReconcileSubject, proposal: KeyProposal): ExtractedKey[] {
    if (proposal.reading === "about") return [];

    return shortIdKeys(collectSentryShortIds(`${subject.text.subject}\n${subject.text.content}`));
  },
};
