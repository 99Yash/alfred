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
 * ## Extensibility
 *
 * A new native integration or an MCP-backed source is `registerContextSource`
 * with a `ContextSource`, and consumers never branch on a source name. That is
 * the seam's design property. It is not yet exercised: no adapter is
 * registered, no consumer calls `searchContext`, and `listContextSources` is
 * the only reader of the registry. The "no consumer edit" claim is proven when
 * #424 and #426 install the first adapter and its caller, not by this slice.
 * Unknown or minimally described MCP sources are expected to be callable tools
 * without being trusted retrieval sources until the manifest declares their
 * read semantics and authority (#466).
 *
 * ## Degradation
 *
 * With no source registered — the state at this slice — `searchContext`
 * returns an empty result. A source that throws becomes one `error` report and
 * never fails the whole search. Absence is reported, never inferred as a
 * closed loop.
 */

export type { ContextSearchRequest } from "@alfred/contracts";

export { listContextSources, registerContextSource } from "./registry";

export { searchContext } from "./search";

export type { ContextSource } from "./types";
