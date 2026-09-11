# ADR-0101 — Context Search is a read-boundary module: registered source adapters, one bounded envelope, no source names in consumers

**Decision.** Cross-integration retrieval gets a new `@alfred/assistant` module, `context-search`, with ONE read-only verb. `searchContext` takes a bounded query/task envelope (`ContextSearchRequest`) and returns a bounded, source-attributed result (`ContextSearchResult`). Sources are `ContextSource` adapters registered by stable id with `registerContextSource`; the boundary enumerates them (`listContextSources`) and never branches on a source name. No model-facing tool is wired to it in this slice.

**Naming.** Epic #422 calls the concept the "Context Fabric". This module is `context-search`, because `context` alone is overloaded across this tree and the boundary's one verb is `searchContext`. The epic keeps its own name; the code stays literal.

Sub-decisions:

1. **A new module, not a fold into an existing one.** The boundary aggregates `@alfred/corpus search`, knowledge `recallMemory` / `readUserContext`, the ADR-0067 `userModelReader`, the object-state store, and later live read-only tools. Each of those subtrees must be able to feed the boundary without importing it, so it cannot live inside any one of them without a cycle.
2. **The source set is data.** `registerContextSource(source)` keys on `source.id`, so adding a native integration or an MCP-backed source is one registration and no chat, briefing, todos, or meeting-prep caller changes. Re-installing the same instance is a no-op; a different instance under a live id throws.
3. **The envelope is validated at the boundary, and owned in contracts.** `contextSearchRequestSchema` bounds `userId`, `query`, `task`, and `limit` before any source runs, and it lives in `@alfred/contracts` with its `CONTEXT_SEARCH_DEFAULT_LIMIT` / `CONTEXT_SEARCH_MAX_LIMIT` caps. The model-facing `system.search_context` tool (#426) derives its bounded input from the same shape and cap rather than inventing a second one.
4. **The result is source-attributed and honest.** Every consulted source gets a report: `ok`, `empty`, or `error`. `empty` and `error` are distinct facts; a throwing source becomes one `error` report carrying `toMessage(error)` and never fails the whole read. Absence is reported, never inferred as a closed loop.
5. **No adapter returns raw bytes or full bodies.** A card carries only a bounded snippet in this slice. Scores, citations, and the opaque `expansionHandle` for live drill-down (#428) are #423's to define. Provider-specific action tools are never invoked by the boundary.
6. **The evidence card is the canonical shared contract (#423 superseded the provisional one).** Slice 1's module-internal `ContextEvidence` was provisional; #423 replaced it with `EvidenceCard` / `evidenceCardSchema` in `@alfred/contracts` and the `packEvidenceCards` renderer in `context-search/pack.ts`. Source adapters, the packer, the source capability manifest (#466), and the later `system.search_context` tool (#426) build on the card; #429 extends media kinds. The packer takes a read result (cards plus per-source reports), not a bare card list, so honest missing/failed notes are structural rather than optional.
7. **Ranking is deferred.** Cards come back in source-registration order, truncated to `limit`. The deterministic ranker (#427) and manifest-driven source priority (#466) replace that without changing the boundary shape.
8. **Discovery is the manifest's job.** Until #466 lands, registration is the only contract. Unknown or minimally described MCP sources are expected to be callable tools without being trusted retrieval sources until their manifest declares read semantics and authority.
9. **Degradation is the default.** With no adapter registered the boundary returns an empty typed result rather than throwing, so a caller can be written before any adapter exists.
10. **The target module set records it.** `context-search` joins `TARGET_ASSISTANT_MODULES` and the plan's target table, so `check:architecture` enforces its public interface from the first slice.

**Extends ADR-0089** (assistant module boundaries). **Depends on ADR-0067** (active user-model projection) and **ADR-0093** (integration registry). **Slice 1 of epic #422.**

---

## Why a boundary instead of per-integration activity tools

The alternative is a curated `<integration>.recent_activity` tool per provider and a consumer that calls several of them and merges by hand. That answers a one-source question and never the cross-source one: the consumer owns the merge, so every new source edits chat, briefing, todos, and meeting prep. It also pushes source identity — which provider, which freshness, which authority — into prose the model has to reason about. The boundary makes the merge and the source attribution one deterministic surface, and makes the source set data.

This is the same split ADR-0071/0074 already draw for tools: a curated per-integration read stays a curated tool, and the moment a question spans integrations it belongs here.

## Alternatives

- **(a) Fold into `knowledge`.** Rejected. `knowledge` feeds the boundary (recall, user context, the projection), so the boundary importing `knowledge` while `knowledge` imports the boundary closes a cycle `check:architecture` refuses. The boundary also reads `corpus` and `connections`, which `knowledge` does not own.
- **(b) One `<integration>.recent_activity` tool per provider.** Rejected. The merge moves into every consumer and each new source edits all of them.
- **(c) Return raw `SearchHit`s.** Rejected. They are unbounded, source-typed, and can carry a full provider body; the boundary exists to return bounded, source-attributed cards.
- **(d) Build the ranker and manifest first.** Rejected for this slice. Adapters need a boundary shape to target; the shape is the prerequisite, not the ranker.
- **(e) Give the boundary drill-down and action powers.** Rejected. The boundary is read-only by construction; provider-specific actions stay separate tools, and live expansion (#428) is bounded read-only.

## Residual risk

- **No adapter is registered yet.** Nothing in production drives dispatch until #424/#425; the empty path is the only path this slice exercises.
- **Source-extensibility is claimed but not exercised.** No consumer calls `searchContext`, so "a new source needs no consumer edit" is proven only when #424 and #426 install the first adapter and its caller.
- **The card surface may still churn.** `EvidenceCard` is canonical and shared, but it is young: `EvidenceCard` grew from a provisional module-internal element, and #425/#429 will extend object-state and media fields additively.
- **The registry is process-global with no composition-root wiring.** #424 or #426 installs the first adapter; until then nothing in production registers a source.
- **An `error` report carries provider text.** `toMessage(error)` may name a provider or carry provider-shaped noise; the boundary sanitizes it and `packEvidenceCards` bounds it with `sanitizeErrorMessage` before it reaches the model, but the model-facing tool (#426) still decides whether to surface it at all.
