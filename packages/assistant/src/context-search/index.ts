/**
 * `context-search` — the canonical read boundary for cross-integration
 * evidence (#422; ADR-0101).
 *
 * One verb, `searchContext`, takes a bounded query/task envelope and returns a
 * bounded, source-attributed evidence list. It is read-only by construction:
 * it never stages an action, never calls a write tool, and never places raw
 * provider bodies or media bytes in its result. Its model-facing caller is the
 * `system.search_context` tool (#426), which reaches it through the
 * `SystemToolContextSearchAdapter` boot seam and returns packed evidence text;
 * the boundary still has no direct model-facing import.
 *
 * ## The card and the packer (#423)
 *
 * The element a source returns is the canonical `EvidenceCard` in
 * `@alfred/contracts` (`src/evidence-card.ts`): it is manifest-interoperable
 * (`source.id` joins the source capability manifest, #466), open to new media
 * and anchors without a schema change (#429), and honest about freshness and
 * missing content. `packEvidenceCards` renders those cards as bounded,
 * cited, model-facing text with per-source missing notes; the model never sees
 * a card object or a raw provider body, only the packer's output. Provider
 * adapters (#424/#425) return cards; the packer and the model-facing tool
 * (#426) consume them.
 *
 * ## Where it sits
 *
 * The boundary is an aggregation seam over primitives that already exist, not a
 * replacement for any of them. The epic's acceptance criteria name some of the
 * substrate by an older name; the mapping is explicit here so a reader can find
 * the code:
 *
 * - **`semanticSearch`** — today the `search` verb in `@alfred/corpus`
 *   (`packages/corpus/src/search.ts`). It is the ingested document/chunk vector
 *   search. A document adapter (#424) wraps it and emits evidence cards; the
 *   boundary does not re-implement pgvector retrieval.
 * - **`read_user_context`** — the `system.read_user_context` tool, backed by
 *   `readUserContext` and `recallMemory` in `@alfred/assistant/knowledge`. A
 *   memory adapter (#424) wraps `recallMemory`; `readUserContext` stays
 *   pull-on-demand for the boss and is not re-routed through here.
 * - **The active user-model projection** — `userModelReader`
 *   (`@alfred/assistant/knowledge`, ADR-0067). The boundary consumes it only as
 *   an optional ranking / entity-resolution signal (#427, #431) and must
 *   degrade when no projection is active; it never writes observations and
 *   never mints a parallel identity graph.
 * - **Object-state** — `objectStateStore`
 *   (`packages/assistant/src/connections/object-state/store.ts`), the
 *   deterministic work-object state. An object-state adapter (#425) surfaces
 *   its rows as `object` evidence with provider/kind/native-state metadata, and
 *   missing state degrades honestly instead of inferring closure from absence.
 * - **Live integration tools** (`packages/assistant/src/tool-runtime`) remain
 *   the provider drill-down and action surface. The boundary's live adapters
 *   (#428) are bounded read-only expansions of thin or stale local hits; they
 *   never invoke a provider-specific action tool.
 * - **The source capability manifest** (#466) is the source-discovery contract,
 *   now live. `SourceManifest` in `@alfred/contracts` is what a source declares
 *   about itself; `manifest.ts` here is the only code that acts on the
 *   declaration. See "Discovery" below.
 *
 * ## The built-in sources (#424, #425)
 *
 * This slice installs the first adapters: `documents` over the corpus vector
 * search, `memory` over `recallMemory`, and `object-state` over the
 * deterministic object-state store. All are private to the module and are
 * installed together by `registerDefaultContextSources`, which the server
 * composition root calls at boot. The vector adapters return canonical cards
 * carrying a source, a citation, a source-native `score`, and a later-expandable
 * handle; the object-state adapter is the same card shape for a card with no
 * text body, reading the request's exact `objects` references rather than the
 * query. They never change an existing direct caller of `search` or
 * `recallMemory`, or the briefing's object-state reconciliation.
 * The adapters are process-registered, not per-request: `searchContext` reads
 * the registry, so no consumer names a source.
 *
 * ## Ranking (#427)
 *
 * `searchContext` ranks the collected cards before it truncates them to the
 * request `limit`. The ranker contract lives in ADR-0101 sub-decision 12;
 * `rank.ts` implements it as a pure function over declared card fields. The
 * per-card working rides on `ContextSearchResult.ranking`, parallel to
 * `evidence`, and is never handed to `packEvidenceCards` — the model
 * structurally cannot see it, while a trace, the retrieval eval (#430), or a
 * test can. The pure ranker itself is a test-support door
 * (`@alfred/assistant/context-search/test-support`), not part of the
 * production interface below.
 *
 * ## Discovery (#466)
 *
 * Every source registers with a `RetrievalSourceManifest`
 * (`@alfred/contracts`): how it can be read (read capabilities, freshness,
 * availability), and how far to trust and how much to spend (authority, cost).
 * The contract reserves a wider catalog surface (`objectKinds`, `mediaKinds`,
 * `identityKeys`, `indexability`, `freshness.windowMinutes`,
 * `cost.typicalLatencyMs`, `discovery`, and the `enumerate` / `expand`
 * capabilities for #428); the boundary does not branch on those yet and
 * production manifests leave them unset. `SourceManifest` stays loose for the
 * catalog case, but registration takes the strict retrieval subtype — at
 * least one read capability and an authority above `unknown` — so a
 * forgotten declaration fails at boot rather than going dark. The ADR-0093
 * integration join (`integration` slug in, `sourceManifestDisplayName` /
 * `sourceManifestDomains` out) is implemented and covered from a fixture, but
 * no built-in source names a slug today: `documents`, `memory`, and
 * `object-state` each span every ingested provider at once, so they declare
 * their own display name and no slug.
 *
 * `searchContext` then SELECTS before it reads. `selectContextSources` excludes
 * a source whose boot-time manifest declares it unavailable and one whose
 * declared reads cannot answer this request. Each
 * exclusion is a `skipped` report with its reason, so "not asked" is visibly
 * different from "asked and found nothing". An undescribed MCP source stays a
 * perfectly callable tool on the
 * `mcp.call` surface and simply cannot register for retrieval until it declares
 * how it can be read and where its evidence comes from. The
 * selection reads declared capability only — no source id and no integration
 * name appears in it.
 *
 * The same manifests feed `contextSourcePriorities`, which fills the ranker's
 * `sourcePriority` seam (ADR-0101 sub-decision 13) by folding each source's
 * authority, freshness, and cost into one number.
 *
 * ## Extensibility
 *
 * A new native integration or an MCP-backed source is `registerContextSource`
 * with a `ContextSource`, and consumers never branch on a source name. That is
 * the seam's design property, now exercised by three adapters and one real
 * consumer: `system.search_context` (#426) reads the registry through
 * `searchContext` and names no source.
 *
 * ## Degradation
 *
 * With no source registered, `searchContext` returns an empty result. A source
 * that throws, or that returns a card violating the `EvidenceCard` contract,
 * becomes one `error` report and never fails the whole search. A source the
 * manifest reader excluded becomes one `skipped` report. Absence is reported,
 * never inferred as a closed loop.
 */

export type { ContextSearchRequest } from "@alfred/contracts";

export { registerContextSource } from "./registry";

export {
  contextSourcePriorities,
  isTrustedRetrievalSource,
  selectContextSources,
  SOURCE_EXCLUSION_REASONS,
} from "./manifest";

export type { SourceExclusionReason } from "./manifest";

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

export type { ContextSource, ContextSourceReads, ContextSourceReader } from "./registry";

export {
  EVIDENCE_PACK_DEFAULT_MAX_CHARS,
  EVIDENCE_PACK_MAX_MAX_CHARS,
  EVIDENCE_PACK_MIN_MAX_CHARS,
  packEvidenceCards,
} from "./pack";

export type { PackedEvidence, PackEvidenceOptions } from "./pack";
