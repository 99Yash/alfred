import {
  contextSearchRequestSchema,
  evidenceCardSchema,
  sanitizeErrorMessage,
  toMessage,
  type ContextSearchRequest,
  type EvidenceCard,
} from "@alfred/contracts";
import { rankEvidenceCards, type EvidenceRanking } from "./rank";
import { listContextSources, type ContextSourceResult } from "./registry";

/**
 * The read-side answer shapes (#422; ADR-0101).
 *
 * These live here — not in a `types.ts` grab-bag — because `searchContext`
 * below is the only code that mints them: every `ContextSourceReport` status
 * (`ok` / `empty` / `error`) and every `ContextSearchResult` truncation to
 * `request.limit` happens in this file. The source-side element is the
 * canonical `EvidenceCard` in `@alfred/contracts` (#423), imported rather than
 * restated here; `registry.ts` owns the `ContextSource` contract that returns
 * it.
 *
 * The card contract and the packing rules live in their own files: the shape in
 * `@alfred/contracts` (browser/server agreement, manifest interoperability) and
 * `pack.ts` here (model-facing rendering). This file only collects and bounds.
 */

/**
 * Per-source outcome for one search. `empty` is distinct from `error` on
 * purpose: "this source found nothing" and "this source could not answer" are
 * different facts, and the honest-missing note (#423) depends on telling them
 * apart.
 */
export type ContextSourceStatus = "ok" | "empty" | "error";

export interface ContextSourceReport {
  readonly sourceId: string;
  readonly status: ContextSourceStatus;
  /**
   * How many cards the source returned. This is the source's own count, before
   * the boundary truncates the combined list to `request.limit`; it does not sum
   * to `ContextSearchResult.evidence.length` when the limit binds.
   */
  readonly evidenceCount: number;
  /** Present only for `error`; the safe message from the failed source. */
  readonly reason?: string | undefined;
}

/** The typed result of one read. `evidence` is empty until adapters land. */
export interface ContextSearchResult {
  /** The parsed request this result answers. */
  readonly request: ContextSearchRequest;
  /** Evidence in ranked order (#427), bounded by `request.limit`. */
  readonly evidence: readonly EvidenceCard[];
  /** One report per registered source consulted. */
  readonly sources: readonly ContextSourceReport[];
  /**
   * The ranker's per-card working, parallel to `evidence` and in the same
   * order (#427).
   *
   * It is a sibling of the evidence, never a field on a card, because the card
   * is what `packEvidenceCards` renders for the model and this is Alfred's
   * internal reasoning about its own retrieval. The packer is not given it and
   * cannot leak it; the `system.search_context` runtime adapter emits it as a
   * debug log per read, and an eval (#430) or a test reads it here.
   */
  readonly ranking: readonly EvidenceRanking[];
}

/**
 * Read-only evidence search across every registered context search source.
 *
 * This is the boundary's one verb. With no source registered — the state at
 * this slice — it returns an empty, typed result rather than throwing, so a
 * caller degrades honestly before any adapter exists. A source that throws
 * becomes one `error` report; it never fails the whole search, and absence
 * never closes a loop.
 *
 * Cards are RANKED before the `limit` truncation (#427), not after collection
 * in registration order. The order of those two steps is the whole point: the
 * pre-#427 boundary truncated a registration-ordered list, so an early source
 * could fill the budget and a strong card from a later source was dropped
 * before anything compared them. `rankEvidenceCards` is a pure function over
 * the cards. The two signals it cannot derive from a card — the ADR-0067
 * user-model weight (#431) and the manifest source priority (#466) — arrive
 * as caller-supplied maps and are absent today, which drops those features
 * rather than defaulting them.
 */
export async function searchContext(request: unknown): Promise<ContextSearchResult> {
  const parsed = contextSearchRequestSchema.parse(request);
  const sources = listContextSources();

  if (sources.length === 0) {
    return { request: parsed, evidence: [], sources: [], ranking: [] };
  }

  const reports: ContextSourceReport[] = [];
  const collected: EvidenceCard[] = [];

  for (const source of sources) {
    let result: ContextSourceResult;

    try {
      result = await source.search(parsed);
    } catch (error) {
      reports.push({
        sourceId: source.id,
        status: "error",
        evidenceCount: 0,
        reason: sanitizeErrorMessage(toMessage(error)),
      });
      continue;
    }

    // A card is a contract, not a type-only promise: validate each card at the
    // boundary so a source cannot smuggle in an unbounded snippet, a
    // non-canonical entity value, an empty card, or a `source.id` that does not
    // match the id it registered as (the manifest join key, #466). A rejected
    // card is dropped without discarding its siblings: one bad card must not
    // erase the good evidence a source returned. A source with any rejected
    // card is reported `error`, and the accepted cards still ship.
    const accepted: EvidenceCard[] = [];
    let rejected = 0;

    try {
      for (const candidate of result.evidence) {
        const parsedCard = evidenceCardSchema.safeParse(candidate);

        if (!parsedCard.success || parsedCard.data.source.id !== source.id) {
          rejected += 1;
          continue;
        }

        accepted.push(parsedCard.data);
      }
    } catch (error) {
      // A source that returned a non-array `evidence` is still one error report,
      // never a rejected read; the cards already accepted still ship.
      reports.push({
        sourceId: source.id,
        status: "error",
        evidenceCount: accepted.length,
        reason: sanitizeErrorMessage(toMessage(error)),
      });
      collected.push(...accepted);
      continue;
    }

    if (rejected > 0) {
      reports.push({
        sourceId: source.id,
        status: "error",
        evidenceCount: accepted.length,
        reason: `${rejected} evidence card(s) violated the contract`,
      });
    } else {
      reports.push({
        sourceId: source.id,
        status: accepted.length > 0 ? "ok" : "empty",
        evidenceCount: accepted.length,
      });
    }

    collected.push(...accepted);
  }

  // One clock reading for the whole rank, so every card's recency decays from
  // the same instant. Taking `new Date()` per card would let two cards with
  // identical timestamps score differently because the loop crossed a
  // millisecond, and the order would stop being reproducible.
  const now = new Date();

  const ranked = rankEvidenceCards(collected, {
    now,
    ...(parsed.objects !== undefined ? { objects: parsed.objects } : {}),
    // Per-entity user-model weights arrive with the ADR-0067 identity work
    // (#431), which also populates `EvidenceCard.entities`. Until then no map
    // is passed, so the `userModel` feature is absent from every card — the
    // same path an unknown entity takes afterwards.
    // Per-source priority arrives with the source capability manifest (#466).
    // Until then no source declares one, which is the same path an unlisted
    // source takes afterwards.
  });

  return {
    request: parsed,
    evidence: ranked.evidence.slice(0, parsed.limit),
    sources: reports,
    ranking: ranked.ranking.slice(0, parsed.limit),
  };
}
