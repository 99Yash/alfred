# Cross-integration + media-wide RAG decision map

Status: bootstrap map, 2026-07-05. Purpose: decide the fastest strong path from today's fragmented retrieval (`semanticSearch`, `read_user_context`, live tools, object-state, partial user-model projection) to a unified evidence assembly layer across integrations and media.

## #1: Is the new user-model substrate blocking cross-integration/media RAG?

Blocked by: none
Type: Discuss

### Question

Do we have to finish ADR-0067 user-model substrate before building a stronger cross-integration and media-wide RAG layer?

### Answer

No for the first useful slice; yes for identity/relationship authority.

Build a `context_fabric` read layer now that can assemble typed evidence from existing sources: `documents/chunks`, `memory_chunks`, live Gmail/Drive/Calendar/GitHub tools, and `integration_objects`. It must treat the active user-model projection as an optional adapter: use it when present, degrade honestly when absent.

Do not block on P2/P3/P4 of ADR-0067 for raw evidence retrieval, media ingestion, object-state reconciliation, or cited answer assembly. Do block user/people significance ranking, cross-source identity merge, subject-bound facts, and relationship traversal on the substrate, because rebuilding those outside ADR-0067 creates another legacy graph.

Implication: two lanes run in parallel.

- Lane A: context fabric and retrieval API, useful immediately.
- Lane B: user-model projection completion, which upgrades Lane A ranking and entity resolution as it lands.

## #2: What is the canonical read API?

Blocked by: #1
Type: Discuss

### Question

Should the canonical interface be a general `search_context` tool/repository, provider-specific tools, or direct prompt access to multiple retrievers?

### Answer

Open. Recommended answer: one server-side `ContextFabric.search()` repository plus one model-facing `system.search_context` tool. Provider-specific tools stay available for live drill-down and actions, but first-pass evidence assembly goes through the fabric so ranking, provenance, dedup, source health, and context packing are centralized.

## #3: What is the evidence card contract?

Blocked by: #2
Type: Discuss

### Question

What typed shape should every retriever return so Gmail messages, PRs, calendar events, docs, images, PDFs, videos, and memory summaries can be ranked and packed together?

### Answer

Open. Recommended answer: an `EvidenceCard` with stable id, source, media type, object identity, entity identities, time bounds, authority/freshness metadata, text snippets, optional visual/page anchors, citations, and expansion handles. The model gets cards; raw bytes/full documents require explicit expansion.

## #4: Which retrieval adapters land first?

Blocked by: #2, #3
Type: Discuss

### Question

What is the smallest adapter set that makes the system meaningfully cross-integration instead of just better Gmail search?

### Answer

Open. Recommended order: existing `documents/chunks` vector adapter, exact object-state adapter, Gmail thread adapter, Drive/Docs text adapter, Calendar window adapter, GitHub object adapter, then media attachment/page adapter. This covers “what happened?”, “what do I owe?”, “who/what is this related to?”, and “what changed since last time?” without waiting for full media pipelines.

## #5: How do we rank evidence?

Blocked by: #3, #4
Type: Discuss

### Question

What features decide the final evidence order across sources?

### Answer

Open. Recommended first ranking model: deterministic weighted scoring, not an LLM reranker by default. Features: query similarity, exact-key match, recency, source authority, live-vs-ingested freshness, object state, thread continuity, user-model significance when available, media extraction confidence, and source health. Add a cheap reranker only after evals show deterministic ranking is insufficient.

## #6: What media-wide means in v1

Blocked by: #3, #4
Type: Discuss

### Question

Does “media-wide” mean OCR/transcription/vision over every attachment immediately, or a staged abstraction that can support all media?

### Answer

Open. Recommended answer: staged abstraction first. V1 supports text, HTML, Google Docs exports, PDFs/page text where already extracted, image OCR/caption when available, and attachment metadata. Full video/audio transcription and visual scene indexing are adapters behind the same card contract, not prerequisites for the fabric.

## #7: What must be evaluated before rollout?

Blocked by: #2, #3, #4, #5
Type: Research

### Question

What golden tasks prove the fabric is better than today's fragmented retrieval?

### Answer

Open. Recommended asset: a small local eval set of 20-40 scenarios with expected evidence ids, not only expected final answers. Include CI loop closure, meeting prep, “who is this person?”, “what did I promise?”, “find the source doc/email”, media attachment lookup, and stale-vs-live conflict cases.

## #8: How does this interact with ADR-0067 completion?

Blocked by: #1, #5
Type: Discuss

### Question

Which parts of ADR-0067 should be pulled forward because they unlock better context fabric behavior?

### Answer

Open. Recommended answer: pull forward only read-side adapters and active identity lookup, not the whole graph. The urgent substrate pieces are stable identity resolution, GitHub object↔entity relations, Calendar observations, and subject-bound facts. But the fabric should be valuable before all four exist.

## #9: Prototype slice

Blocked by: #2, #3, #4, #5
Type: Prototype

### Question

What is the fastest prototype that proves the architecture?

### Answer

Open. Recommended prototype: `ContextFabric.search()` with three adapters: vector `documents/chunks`, object-state, and Gmail/Drive exact lookups. Return evidence cards and use it from chat through `system.search_context` for read-only questions. No media extraction expansion yet; just card contract and ranking.
