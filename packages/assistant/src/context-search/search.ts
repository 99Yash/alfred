import {
  contextSearchRequestSchema,
  evidenceCardSchema,
  sanitizeErrorMessage,
  sourceManifestSupportsRead,
  toMessage,
  type ContextSearchRequest,
  type EvidenceCard,
} from "@alfred/contracts";
import { expandEvidence, type EvidenceExpansion } from "./expand";
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

/**
 * A source that answered: `ok` with cards, `empty` without. Never carries a
 * reason.
 *
 * `evidenceCount` is the source's own PRE-LIMIT count — what it returned, not
 * what survived `request.limit` — so the difference from the cards in the
 * result names what the read dropped. The expansion phase (#1077) is the one
 * thing that moves it after the fact: a card a live source refreshed is
 * contributed by that live source and no longer by the source it replaced, so
 * the phase decrements the origin's count as it credits the expander. Without
 * that transfer the two sources would both claim one card and the packer would
 * report a refreshed card as an item it had dropped. The `ok` STATUS never
 * moves: a source that answered still reports `ok` even when every card it
 * contributed was refreshed away, because it did answer. The mirror holds for
 * `empty`: a source that answered with nothing and then contributed a refresh
 * reports `ok`, because it now has a card in the pack — an `empty` beside its
 * own refreshed card would be the same lie in reverse.
 */
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
   * The ranker's per-card working, parallel to `evidence` BY RANK POSITION and
   * in the same order (#427).
   *
   * It records the cards AS RANKED. The expansion phase runs after the rank and
   * replaces a card in place without re-ranking, so a refreshed position's row
   * still names the card the refresh replaced (#1077) — which is what makes the
   * refresh visible in a trace rather than invisible. After expansion,
   * `ranking[i].cardId` may therefore differ from `evidence[i].id`: join by
   * index, never by card id.
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
 *
 * Cards are EXPANDED after the truncation (#1077), in a second phase this file
 * delegates to `expand.ts`. Only a surviving card is worth a provider round
 * trip, and only a decided rank can hand a refresh a position to take.
 * `request.expand: false` turns the phase off for a caller that cannot pay it.
 * The phase runs its expanders in parallel under a deadline
 * (`CONTEXT_SEARCH_EXPANSION_TIMEOUT_MS`): the count cap bounds how many round
 * trips the read pays for, the deadline bounds how long it waits for them, and
 * every expander receives the phase's abort signal. The phase's one effect on
 * this file is on the REPORTS: an `expansion-only` skip the phase consulted
 * reports its real outcome in its registration position, and every other
 * report keeps the status it earned on the query with only its count moved, so
 * the result still holds exactly one report per registered source in
 * registration order.
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
    let declined: SourceExclusionReason | undefined;

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

      // The source itself said it could not be asked, for a per-read reason no
      // boot-time manifest could carry (#1078). The first such statement wins;
      // the checks below decide whether it survives what the other readers did.
      declined ??= result.skipped;
    }

    if (failure === undefined && accepted.length === 0 && declined !== undefined) {
      // A source that declined and produced nothing was never really asked, so
      // it reports `skipped` rather than the `empty` that would tell the model
      // it looked and found nothing. A source that also answered, or that also
      // failed, reports what it did instead: the stronger fact is the one a
      // reader of the pack has to act on.
      reports.push({ sourceId: source.id, status: "skipped", evidenceCount: 0, reason: declined });
      continue;
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

  const evidence = ranked.evidence.slice(0, parsed.limit);
  const ranking = ranked.ranking.slice(0, parsed.limit);

  if (!parsed.expand) return { request: parsed, evidence, sources: reports, ranking };

  const expansion = await expandEvidence({ sources, evidence, request: parsed });

  return {
    request: parsed,
    evidence: expansion.evidence,
    sources: reports.map((report) => reportAfterExpansion(report, expansion)),
    ranking,
  };
}

/**
 * One source's report once the expansion phase has run (#1077).
 *
 * The phase touches a report in two ways, and a source can take both at once (a
 * source that expands its OWN handles is both the origin and the expander, and
 * the two adjustments then cancel):
 *
 * - it CONSULTED the source, so an `expansion-only` skip reports the real
 *   outcome of its only consultation — `ok` with the refreshed cards, `error`
 *   on failure. A skip consulted but returning nothing stays a skip: the
 *   source was never asked the query, so `empty` would claim it was asked and
 *   had nothing;
 * - it REPLACED a card the source contributed, so that card now belongs to the
 *   expander and the origin's count drops by one.
 *
 * A source that already answered the query keeps the status it earned there.
 * An expansion answers a different question ("read the record behind this
 * card"), so its failure must not rewrite a healthy `ok` into an `error`
 * beside the source's own cards — the failure is local, the original card
 * stays, and only the count moves. The one mirror: an `empty` source whose
 * refresh landed now contributes, so it becomes `ok` rather than sitting
 * `empty` beside its own card.
 *
 * A source the phase did neither to is returned untouched, so the common read —
 * no expander registered — rebuilds nothing.
 */
function reportAfterExpansion(
  report: ContextSourceReport,
  expansion: EvidenceExpansion,
): ContextSourceReport {
  const outcome = expansion.expanders.get(report.sourceId);
  const replaced = expansion.replaced.get(report.sourceId) ?? 0;

  if (outcome === undefined && replaced === 0) return report;

  const contributed = report.status === "skipped" ? 0 : report.evidenceCount;
  const evidenceCount = Math.max(0, contributed - replaced) + (outcome?.refreshed ?? 0);

  // A first-phase failure still stands: the expansion answered a different
  // question, and hiding the earlier error behind it would lose the fact that
  // the source could not answer the query. When the expansion failed too, its
  // failure is chained onto the reason rather than silently dropped, so both
  // facts survive in the one `reason` the report shape carries.
  if (report.status === "error") {
    if (outcome?.failure !== undefined) {
      return {
        ...report,
        evidenceCount,
        reason: `${report.reason} | expansion: ${outcome.failure}`,
      };
    }

    return { ...report, evidenceCount };
  }

  // The phase's only consultation of this source was the expansion. A failure
  // there is a real `error`; a refresh is a real contribution (`ok`); but a
  // consultation that returned nothing leaves the skip standing, because the
  // source was never asked the query and `empty` would claim it was.
  if (report.status === "skipped") {
    if (outcome?.failure !== undefined) {
      return { sourceId: report.sourceId, status: "error", evidenceCount, reason: outcome.failure };
    }

    if ((outcome?.refreshed ?? 0) === 0) return report;

    return { sourceId: report.sourceId, status: "ok", evidenceCount };
  }

  // A source that answered the query keeps its status: an expansion failure is
  // local (the original card stays) and must not rewrite `ok` into `error`
  // beside the source's own cards. The mirror moves the other way: an `empty`
  // source whose refresh landed now contributes, so it becomes `ok`.
  if (report.status === "empty" && evidenceCount > 0) {
    return { sourceId: report.sourceId, status: "ok", evidenceCount };
  }

  return { ...report, evidenceCount };
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
