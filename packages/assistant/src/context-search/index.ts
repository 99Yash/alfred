/**
 * `context-search`: the read-only boundary for cross-integration evidence (ADR-0101).
 * `searchContext` selects sources by manifest (#466), reads them, ranks the
 * cards (#427), cuts to `limit`, and expands the survivors live (#1077).
 * `packEvidenceCards` renders the result; the model never sees a card object.
 * Its model-facing caller is `system.search_context`, through the
 * `SystemToolContextSearchAdapter` boot seam.
 *
 * Built-in sources wrap existing primitives and do not replace them:
 * `documents` (corpus `search`, the epic's `semanticSearch`), `memory` (`recallMemory`), `object-state`
 * (`objectStateStore`), and live `drive`. `registerDefaultContextSources`
 * installs them at boot. Consumers never name a source.
 *
 * A failed or invalid source is one `error` report; an excluded source is one
 * `skipped` report. Absence is reported, never read as a closed loop.
 */

export type { ContextSearchRequest } from "@alfred/contracts";

export { registerContextSource } from "./registry";

export {
  contextSourcePriorities,
  isTrustedRetrievalSource,
  selectContextSources,
  SELECTION_EXCLUSION_REASONS,
  SOURCE_EXCLUSION_REASONS,
} from "./manifest";

export type { SelectionExclusionReason, SourceExclusionReason } from "./manifest";

export { READER_DECLINED_REASONS } from "./registry";

export { registerDefaultContextSources } from "./default-sources";

export { searchContext } from "./search";

export type {
  ContextSearchResult,
  ContextSourceErrorReport,
  ContextSourceOkReport,
  ContextSourceReport,
  ContextSourceSkippedReport,
  ContextSourceStatus,
} from "./search";

export type { EvidenceRanking } from "./rank";

export type {
  ContextSource,
  ContextSourceExpander,
  ContextSourceReads,
  ContextSourceReader,
  ReaderDeclinedReason,
} from "./registry";

export {
  EVIDENCE_PACK_DEFAULT_MAX_CHARS,
  EVIDENCE_PACK_MAX_MAX_CHARS,
  EVIDENCE_PACK_MIN_MAX_CHARS,
  packEvidenceCards,
} from "./pack";

export type { PackedEvidence, PackEvidenceOptions } from "./pack";
