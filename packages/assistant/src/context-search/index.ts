/**
 * `context-search` — the canonical read boundary for cross-integration
 * evidence (#422; ADR-0101).
 *
 * One verb, `searchContext`, takes a bounded query/task envelope and returns a
 * bounded, source-attributed evidence list. It is read-only by construction:
 * it never stages an action, never calls a write tool, and never places raw
 * provider bodies or media bytes in its result. A model-facing
 * `system.search_context` tool is a later slice (#426); this boundary is
 * deliberately not wired to one yet.
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
 * - **The source capability manifest** (#466) is the source-discovery contract.
 *   The boundary enumerates candidate sources from it rather than a hard-coded
 *   switch over today's integrations. Until it lands, adapters register by id
 *   through `registerContextSource`.
 *
 * ## The built-in sources (#424)
 *
 * This slice installs the first adapters: `documents` over the corpus vector
 * search and `memory` over `recallMemory`. Both are private to the module and
 * are installed together by `registerDefaultContextSources`, which the server
 * composition root calls at boot. They return canonical cards carrying a
 * source, a citation, a source-native `score`, and a later-expandable handle;
 * they never change an existing direct caller of `search` or `recallMemory`.
 * The adapters are process-registered, not per-request: `searchContext` reads
 * the registry, so no consumer names a source.
 *
 * ## Extensibility
 *
 * A new native integration or an MCP-backed source is `registerContextSource`
 * with a `ContextSource`, and consumers never branch on a source name. That is
 * the seam's design property, now exercised by two adapters. It is not yet
 * exercised end to end: no consumer calls `searchContext` until the
 * model-facing tool lands (#426). Unknown or minimally described MCP sources
 * are expected to be callable tools without being trusted retrieval sources
 * until the manifest declares their read semantics and authority (#466).
 *
 * ## Degradation
 *
 * With no source registered, `searchContext` returns an empty result. A source
 * that throws, or that returns a card violating the `EvidenceCard` contract,
 * becomes one `error` report and never fails the whole search. Absence is
 * reported, never inferred as a closed loop.
 */

export type { ContextSearchRequest } from "@alfred/contracts";

export { listContextSources, registerContextSource } from "./registry";

export { registerDefaultContextSources } from "./default-sources";

export { searchContext } from "./search";

export type { ContextSearchResult, ContextSourceReport } from "./search";

export type { ContextSource } from "./registry";

export {
  EVIDENCE_PACK_DEFAULT_MAX_CHARS,
  EVIDENCE_PACK_MAX_MAX_CHARS,
  EVIDENCE_PACK_MIN_MAX_CHARS,
  packEvidenceCards,
} from "./pack";

export type { PackedEvidence, PackEvidenceOptions } from "./pack";
