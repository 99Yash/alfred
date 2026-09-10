/**
 * `context-fabric` — the canonical read boundary for cross-integration
 * evidence (#422).
 *
 * One verb, `searchContext`, takes a bounded query/task envelope and returns a
 * bounded, source-attributed evidence list. It is read-only by construction:
 * it never stages an action, never calls a write tool, and never places raw
 * provider bodies or media bytes in its result. A model-facing
 * `system.search_context` tool is a later slice (#426); this boundary is
 * deliberately not wired to one yet.
 *
 * ## Where it sits
 *
 * The fabric is an aggregation seam over primitives that already exist, not a
 * replacement for any of them:
 *
 * - **`search`** (`@alfred/corpus`) is the ingested document/chunk vector
 *   search. A document adapter (#424) wraps it and emits evidence cards; the
 *   fabric does not re-implement pgvector retrieval.
 * - **`recallMemory`** and **`readUserContext`** (`@alfred/assistant/knowledge`)
 *   are the memory-recall and durable-user-context reads. A memory adapter
 *   (#424) wraps the former; `readUserContext` stays pull-on-demand for the
 *   boss and is not re-routed through here.
 * - **`userModelReader`** (`@alfred/assistant/knowledge`, ADR-0067) is the
 *   active user-model projection. The fabric consumes it only as an optional
 *   ranking / entity-resolution signal (#427, #431) and must degrade when no
 *   projection is active; it never writes observations and never mints a
 *   parallel identity graph.
 * - **`objectStateStore`**
 *   (`packages/assistant/src/connections/object-state/store.ts`) is
 *   the deterministic work-object state. An object-state adapter (#425)
 *   surfaces its rows as `object` evidence with provider/kind/native-state
 *   metadata, and missing state degrades honestly instead of inferring
 *   closure from absence.
 * - **Live integration tools** (`packages/assistant/src/tool-runtime`) remain
 *   the provider drill-down and action surface. The fabric's live adapters
 *   (#428) are bounded read-only expansions of thin or stale local hits; they
 *   never invoke a provider-specific action tool.
 * - **The source capability manifest** (#466) is the source-discovery contract.
 *   The fabric enumerates candidate sources from it rather than a hard-coded
 *   switch over today's integrations. Until it lands, adapters register by id
 *   through `registerContextSource`.
 *
 * ## Extensibility
 *
 * Adding a native integration or an MCP-backed source is `registerContextSource`
 * with a `ContextSource`; no chat, briefing, todos, or meeting-prep caller
 * changes, and consumers never branch on a source name. Unknown or minimally
 * described sources are expected to be callable tools without being trusted
 * retrieval sources until the manifest declares their read semantics and
 * authority (#466).
 *
 * ## Degradation
 *
 * With no source registered — the state at this slice — `searchContext`
 * returns an empty result. A source that throws becomes one `error` report and
 * never fails the whole search. Absence is reported, never inferred as a
 * closed loop.
 */

export {
  CONTEXT_SEARCH_DEFAULT_LIMIT,
  CONTEXT_SEARCH_MAX_LIMIT,
  contextSearchRequestSchema,
  type ContextSearchRequest,
} from "./contracts";

export { listContextSources, registerContextSource } from "./registry";

export { searchContext } from "./search";

export type {
  ContextEvidence,
  ContextMediaType,
  ContextSearchResult,
  ContextSource,
  ContextSourceReport,
  ContextSourceResult,
  ContextSourceStatus,
} from "./types";
