import {
  CONTEXT_SEARCH_COLLECT_TIMEOUT_MS,
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
import {
  cardManifestViolation,
  listContextSources,
  type CardManifestViolation,
  type ContextSource,
  type ContextSourceResult,
  type ReaderDeclinedReason,
} from "./registry";

/** Read-side answer shapes (ADR-0101). This file collects and bounds; `pack.ts` renders. */

/**
 * A source that answered: `ok` with cards, `empty` without.
 * `evidenceCount` is the pre-limit count. Expansion (#1077) moves a refreshed
 * card's count from its origin to the expander, so neither double-counts it.
 */
export interface ContextSourceOkReport {
  readonly sourceId: string;
  readonly status: "ok" | "empty";
  readonly evidenceCount: number;
}

/** `reason` is provider text, sanitized at the boundary. */
export interface ContextSourceErrorReport {
  readonly sourceId: string;
  readonly status: "error";
  readonly evidenceCount: number;
  readonly reason: string;
}

/** A source never asked. `reason` is a closed enum, so the packer needs no sanitizer. */
export interface ContextSourceSkippedReport {
  readonly sourceId: string;
  readonly status: "skipped";
  readonly evidenceCount: 0;
  readonly reason: SourceExclusionReason;
}

/** "Found nothing", "could not answer", and "never asked" are different facts (#466). */
export type ContextSourceReport =
  | ContextSourceOkReport
  | ContextSourceErrorReport
  | ContextSourceSkippedReport;

export type ContextSourceStatus = ContextSourceReport["status"];

export interface ContextSearchResult {
  readonly request: ContextSearchRequest;
  /** Ranked (#427), then cut to `request.limit`. */
  readonly evidence: readonly EvidenceCard[];
  /** One report per registered source, so an excluded source still appears as `skipped`. */
  readonly sources: readonly ContextSourceReport[];
  /**
   * Rankings parallel to `evidence`. Kept off the card so the packer cannot leak it.
   * Expansion replaces cards without a rerank, so join by index, never by card id.
   */
  readonly ranking: readonly EvidenceRanking[];
}

/**
 * Read-only evidence search across every registered source.
 * Select by manifest (#466), read, validate each card, rank (#427), cut to
 * `limit`, then expand the survivors (#1077). Ranking before the cut lets a
 * late source's strong card survive. A throwing source becomes one `error`
 * report, never a failed search.
 */
export async function searchContext(request: unknown): Promise<ContextSearchResult> {
  const parsed = contextSearchRequestSchema.parse(request);
  const sources = listContextSources();

  if (sources.length === 0) {
    return { request: parsed, evidence: [], sources: [], ranking: [] };
  }

  // Registration order, so an exclusion never reshuffles the report list.
  // One deadline covers the whole collect, so slow readers cannot stack timeouts.
  const excluded = selectContextSources(sources, parsed);
  const collectSignal = AbortSignal.timeout(CONTEXT_SEARCH_COLLECT_TIMEOUT_MS);

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
    let declined: ReaderDeclinedReason | undefined;

    for (const read of readers) {
      let result: ContextSourceResult;

      try {
        result = await readWithCollectTimeout(read, parsed, collectSignal);
      } catch (error) {
        failure = sanitizeErrorMessage(toMessage(error));
        continue;
      }

      // Validate each card. A bad card drops alone; its siblings still ship.
      let rejected = 0;
      const rejectedReasons = new Set<CardManifestViolation>();

      try {
        for (const candidate of result.evidence) {
          const parsedCard = evidenceCardSchema.safeParse(candidate);

          if (!parsedCard.success) {
            rejected += 1;
            continue;
          }

          const violation = cardManifestViolation(parsedCard.data, source);

          if (violation !== undefined) {
            rejected += 1;
            rejectedReasons.add(violation);
            continue;
          }

          accepted.push(parsedCard.data);
        }
      } catch (error) {
        // A non-array `evidence` is one error report. Accepted cards still ship.
        failure = sanitizeErrorMessage(toMessage(error));
        continue;
      }

      if (rejected > 0) {
        const detail = rejectedReasons.size > 0 ? `: ${[...rejectedReasons].join(", ")}` : "";

        failure = `${rejected} evidence card(s) violated the contract${detail}`;
      }

      // First decline wins (#1078). The checks below decide if it survives.
      declined ??= result.skipped;
    }

    if (failure === undefined && accepted.length === 0 && declined !== undefined) {
      // Declined with no cards and no failure: report `skipped`, not `empty`.
      reports.push({ sourceId: source.id, status: "skipped", evidenceCount: 0, reason: declined });
      continue;
    }

    if (failure !== undefined) {
      // A rejected card or a thrown reader is `error`. Accepted cards still ship.
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

  // One clock reading, so equal timestamps score the same.
  const now = new Date();

  const ranked = rankEvidenceCards(collected, {
    now,
    ...(parsed.objects !== undefined ? { objects: parsed.objects } : {}),
    // No `entitySignificance` yet (#431), so `userModel` is absent on every card.
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
 * Adjust a report after expansion (#1077). A replaced card moves its count to
 * the expander. An expansion failure becomes `error`, so a bad refresh is not silent.
 * A consulted `expansion-only` skip reports its real outcome; with nothing
 * returned it stays `skipped`. An `empty` source with a landed refresh becomes `ok`.
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

  // Keep the query failure, and chain any expansion failure onto it.
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

  // Never asked the query: no refresh keeps the skip, because `empty` would claim it was.
  if (report.status === "skipped") {
    if (outcome?.failure !== undefined) {
      return { sourceId: report.sourceId, status: "error", evidenceCount, reason: outcome.failure };
    }

    if ((outcome?.refreshed ?? 0) === 0) return report;

    return { sourceId: report.sourceId, status: "ok", evidenceCount };
  }

  // Without this, a rejected refresh would keep `ok` and report nothing.
  if (report.status === "ok" || report.status === "empty") {
    if (outcome?.failure !== undefined) {
      return { sourceId: report.sourceId, status: "error", evidenceCount, reason: outcome.failure };
    }

    if (report.status === "empty" && evidenceCount > 0) {
      return { sourceId: report.sourceId, status: "ok", evidenceCount };
    }

    return { ...report, evidenceCount };
  }

  return { ...report, evidenceCount };
}

/** Our own words, never provider text. */
const COLLECT_TIMEOUT_FAILURE = "the source timed out";

/**
 * Race a reader against the collect deadline. The race bounds a reader that
 * ignores the signal; its stray promise settles unobserved.
 */
function readWithCollectTimeout(
  read: (request: ContextSearchRequest, signal: AbortSignal) => Promise<ContextSourceResult>,
  request: ContextSearchRequest,
  signal: AbortSignal,
): Promise<ContextSourceResult> {
  if (signal.aborted) return Promise.reject(new Error(COLLECT_TIMEOUT_FAILURE));

  return new Promise<ContextSourceResult>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new Error(COLLECT_TIMEOUT_FAILURE));
    };

    signal.addEventListener("abort", onAbort, { once: true });

    read(request, signal).then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Readers for this request, in call order: `semantic_search`, else
 * `keyword_search`, then `exact_lookup` when the request has objects.
 */
function answeringReaders(
  source: ContextSource,
  request: ContextSearchRequest,
): ((request: ContextSearchRequest, signal: AbortSignal) => Promise<ContextSourceResult>)[] {
  const readers: ((
    request: ContextSearchRequest,
    signal: AbortSignal,
  ) => Promise<ContextSourceResult>)[] = [];

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
