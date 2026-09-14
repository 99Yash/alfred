import {
  contextSearchRequestSchema,
  evidenceCardSchema,
  sanitizeErrorMessage,
  sourceManifestSupportsRead,
  toMessage,
  type ContextSearchRequest,
  type EvidenceCard,
} from "@alfred/contracts";
import {
  contextSourcePriorities,
  selectContextSources,
  type SourceExclusionReason,
} from "./manifest";
import { rankEvidenceCards, type EvidenceRanking } from "./rank";
import { listContextSources, type ContextSource, type ContextSourceResult } from "./registry";

/**
 * The read-side answer shapes (#422; ADR-0101).
 *
 * These live here — not in a `types.ts` grab-bag — because `searchContext`
 * below is the only code that mints them: every `ContextSourceReport` status
 * (`ok` / `empty` / `error` / `skipped`) and every `ContextSearchResult`
 * truncation to `request.limit` happens in this file. The source-side element is the
 * canonical `EvidenceCard` in `@alfred/contracts` (#423), imported rather than
 * restated here; `registry.ts` owns the `ContextSource` contract that returns
 * it.
 *
 * The card contract and the packing rules live in their own files: the shape in
 * `@alfred/contracts` (browser/server agreement, manifest interoperability) and
 * `pack.ts` here (model-facing rendering). This file only collects and bounds.
 */

/** A source that answered: `ok` with cards, `empty` without. Never carries a reason. */
export interface ContextSourceOkReport {
  readonly sourceId: string;
  readonly status: "ok" | "empty";
  readonly evidenceCount: number;
}

/** A source that failed. `reason` is untrusted provider text, sanitized at the boundary. */
export interface ContextSourceErrorReport {
  readonly sourceId: string;
  readonly status: "error";
  readonly evidenceCount: number;
  readonly reason: string;
}

/**
 * A source that was never asked. `reason` is our own closed
 * {@link SourceExclusionReason}, never provider text — the packer renders it
 * from a lookup table without sanitizing.
 */
export interface ContextSourceSkippedReport {
  readonly sourceId: string;
  readonly status: "skipped";
  readonly evidenceCount: 0;
  readonly reason: SourceExclusionReason;
}

/**
 * Per-source outcome for one search. A discriminated union on purpose, so
 * three illegal states stop compiling: `ok` / `empty` with a reason, `error`
 * without one, and `skipped` with an arbitrary string. The distinctions carry
 * the boundary's honesty rule down to the source level: "found nothing"
 * (`empty`), "could not answer" (`error`), and "was never asked" (`skipped`,
 * #466) are three different facts, and the honest-missing note (#423) depends
 * on telling them apart.
 */
export type ContextSourceReport =
  | ContextSourceOkReport
  | ContextSourceErrorReport
  | ContextSourceSkippedReport;

export type ContextSourceStatus = ContextSourceReport["status"];

/** The typed result of one read. `evidence` is empty until adapters land. */
export interface ContextSearchResult {
  /** The parsed request this result answers. */
  readonly request: ContextSearchRequest;
  /** Evidence in ranked order (#427), bounded by `request.limit`. */
  readonly evidence: readonly EvidenceCard[];
  /**
   * One report per REGISTERED source, not per consulted source. A source the
   * manifest reader excluded from this read (#466) is reported `skipped` with
   * its reason, so a source never disappears from the answer.
   */
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
 * Sources are SELECTED before they are read (#466). `selectContextSources`
 * reads each source's capability manifest and drops the ones this request
 * cannot usefully ask — a source whose boot-time manifest declares it
 * unavailable, and one whose declared reads do not answer this request.
 * Registration already guarantees read semantics and an authority above
 * `unknown`, so those are boot errors rather than per-read exclusions. Each
 * becomes a `skipped` report, so exclusion is stated rather than silent. The
 * selection reads only declared capability: no source id and no integration
 * name appears in it.
 *
 * Cards are RANKED before the `limit` truncation (#427), not after collection
 * in registration order. The order of those two steps is the whole point: the
 * pre-#427 boundary truncated a registration-ordered list, so an early source
 * could fill the budget and a strong card from a later source was dropped
 * before anything compared them. `rankEvidenceCards` is a pure function over
 * the cards, and the one signal it cannot derive from a card or a manifest —
 * the ADR-0067 user-model weight (#431) — arrives as a caller-supplied map and
 * is absent today, which drops that feature rather than defaulting it.
 */
export async function searchContext(request: unknown): Promise<ContextSearchResult> {
  const parsed = contextSearchRequestSchema.parse(request);
  const sources = listContextSources();

  if (sources.length === 0) {
    return { request: parsed, evidence: [], sources: [], ranking: [] };
  }

  // One loop in REGISTRATION order: an excluded source reports `skipped`
  // without running, a candidate runs its answering readers. A reader
  // comparing two traces never sees the source list reshuffle just because a
  // manifest started excluding one of them.
  const excluded = selectContextSources(sources, parsed);

  const reports: ContextSourceReport[] = [];
  const collected: EvidenceCard[] = [];
  const consulted: ContextSource[] = [];

  for (const source of sources) {
    const exclusion = excluded.get(source.id);

    if (exclusion !== undefined) {
      reports.push({ sourceId: source.id, status: "skipped", evidenceCount: 0, reason: exclusion });
      continue;
    }

    consulted.push(source);

    const readers = answeringReaders(source, parsed);

    const accepted: EvidenceCard[] = [];
    let failure: string | undefined;

    for (const read of readers) {
      let result: ContextSourceResult;

      try {
        result = await read(parsed);
      } catch (error) {
        failure = sanitizeErrorMessage(toMessage(error));
        continue;
      }

      // A card is a contract, not a type-only promise: validate each card at
      // the boundary so a source cannot smuggle in an unbounded snippet, a
      // non-canonical entity value, an empty card, or a `source.id` that does
      // not match the id it registered as (the manifest join key, #466). A
      // rejected card is dropped without discarding its siblings: one bad card
      // must not erase the good evidence a source returned.
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
        // A source that returned a non-array `evidence` is still one error
        // report, never a rejected read; the cards already accepted still ship.
        failure = sanitizeErrorMessage(toMessage(error));
        continue;
      }

      if (rejected > 0) {
        failure = `${rejected} evidence card(s) violated the contract`;
      }
    }

    if (failure !== undefined) {
      // A source with any rejected card, or any throwing reader, is reported
      // `error`, and the accepted cards still ship.
      reports.push({
        sourceId: source.id,
        status: "error",
        evidenceCount: accepted.length,
        reason: failure,
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
    sourcePriority: contextSourcePriorities(consulted),
  });

  return {
    request: parsed,
    evidence: ranked.evidence.slice(0, parsed.limit),
    sources: reports,
    ranking: ranked.ranking.slice(0, parsed.limit),
  };
}

/**
 * The readers that answer this request, in call order.
 *
 * Free text first (`semantic_search`, falling back to `keyword_search`), then
 * `exact_lookup` when the request carries object references. A source with both
 * answers both sides of a combined request; registration guarantees every
 * named reader exists, so the lookups below are total without a guard.
 */
function answeringReaders(
  source: ContextSource,
  request: ContextSearchRequest,
): ((request: ContextSearchRequest) => Promise<ContextSourceResult>)[] {
  const readers: ((request: ContextSearchRequest) => Promise<ContextSourceResult>)[] = [];

  if (sourceManifestSupportsRead(source.manifest, "semantic_search")) {
    const read = source.reads["semantic_search"];

    if (read !== undefined) readers.push(read);
  } else if (sourceManifestSupportsRead(source.manifest, "keyword_search")) {
    const read = source.reads["keyword_search"];

    if (read !== undefined) readers.push(read);
  }

  if (
    (request.objects?.length ?? 0) > 0 &&
    sourceManifestSupportsRead(source.manifest, "exact_lookup")
  ) {
    const read = source.reads["exact_lookup"];

    if (read !== undefined) readers.push(read);
  }

  return readers;
}
