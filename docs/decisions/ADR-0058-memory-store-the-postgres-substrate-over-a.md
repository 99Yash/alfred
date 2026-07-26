# ADR-0058 — Memory store: the Postgres substrate over a graph DB; build the memory intelligence, don't buy the store


**Decision.** Alfred's long-term memory **stays on the existing Postgres substrate** (`user_facts`, `entities` + `entity_relations`, `memory_chunks` pgvector, `style_profiles`, `person_profiles`), and the recurring **memory intelligence** (extraction, entity resolution, contradiction handling, lifecycle) is **built as logic over that substrate** rather than delegated to a memory service (Mem0, Zep/Graphiti, Letta). We adopt a graph **model** (`entities`/`entity_relations`) but **not a graph engine** (Neo4j/FalkorDB). This is the build-vs-buy decision that ADR-0056/0057 assumed but never stated explicitly; it closes the question for future readers and pins the revisit trigger.

**Why this is its own ADR.** Surfaced 2026-06-14 while planning the long-term-memory vertical slice (the "stop emailing me about Ben Book" loop, see [docs/plans/long-term-memory-v1.md](../plans/long-term-memory-v1.md)): the failure was not isolated, the roadmap wants steadily more memory capability, and the natural reflex — "wouldn't Zep/Neo4j just be better than maneuvering through Postgres?" — is a real, hard-to-reverse trade-off. The mistake the ADR guards against is conflating two separable layers: the **store** (where memory lives) and the **intelligence** (the pipeline that maintains it).

**Micro-decisions.**

1. **Storage engine — Postgres, because the graph DB advantage is a scale advantage Alfred doesn't have.** A graph engine wins at millions of nodes and deep, high-degree traversal. Alfred is **single-user** ([ADR-0001](#adr-0001)): the graph is one person + their contacts + orgs + relations — hundreds to low thousands of nodes. At that cardinality a multi-hop query ("who connects me to someone at Acme") is a millisecond recursive CTE; Neo4j's traversal engine is built to beat Postgres at 10M nodes, not 2K. The graph **model** (people → relationships → orgs) is kept — expressed as `entity_relations` rows + pgvector — but the **engine** is not adopted.

2. **The temporal capability the graph DBs sell, we already have.** Zep/Graphiti's headline is bi-temporal modeling + automatic fact invalidation ("what was true in Q1," understand a NY→SF *transition* rather than overwrite). `user_facts` (`valid_from`/`valid_until`/`supersedes_id`/`status` chain, ADR-0019/0056) is exactly that, hand-rolled and better-fit to our reversibility UX. Buying it would be trading **down**.

3. **A memory service is not separable from its store — and moving the store out of Postgres breaks the product.** Zep Cloud is managed (the entire memory + relationship graph leaves our DB to a third party — directly against the privacy positioning and [ADR-0038](#adr-0038) content-at-rest posture); Zep self-host *requires* the Neo4j/FalkorDB backend. Either way memory's source of truth leaves Postgres. But the ADR-0056 **in-app memory changelog (confirm/edit/reject, one-by-one) is Replicache-synced off `user_facts.row_version`**, and triage/briefing/meeting-prep/todos/cold-start all read the PG substrate. Relocating the store means either maintaining a second store **plus** a Zep→PG mirror (strictly *more* abstraction than building) or forfeiting the reversibility surface ADR-0056 is built on. Adopting the graph DB doesn't remove the maneuvering; it relocates it into a sync layer.

4. **Buy the patterns, not the package.** The genuinely hard, recurring work is the **intelligence pipeline**, not the database — and that value is a pipeline you can have without the store. Mem0's `ADD / UPDATE / DELETE / NOOP` operation taxonomy is adopted as the **shape** of the write-time-contradiction logic (ADR-0056 micro-decision 4), implemented directly over `proposeFact`/`supersedeFact`. No runtime dependency, no second store.

5. **Recall scaling stays PG-native.** If name/ID recall needs more than pgvector cosine, the answer is the already-chosen P6 path — Postgres `tsvector` FTS + pgvector fused via RRF — **no new infra** (consistent with the existing "Not turbopuffer" stance).

**Revisit trigger (written in so this isn't re-litigated).** The one condition that flips this: **multi-tenant Alfred at scale** — many users, large merged graphs, frequent deep traversals under latency pressure. Single-user Alfred never reaches it. If Alfred becomes a multi-user product *and* traversal latency becomes a measured bottleneck, benchmark a graph engine for the **graph limb only** (`entities`/`entity_relations`) — never the facts/preferences, which stay in Postgres for the reversibility UX.

**What this amends / builds on.**

- **Snapshot rows `DB` / `Memory`** — makes the "structured tables + pgvector" choice explicit *against the alternative*, and binds the memory roadmap to it.
- **ADR-0056 / ADR-0057** — states the build-vs-buy premise both assumed ("substrate frozen, adopted as-is"); the intelligence-not-store framing is the rationale for building the `system.*` write tools rather than wrapping a service.
- **ADR-0038** — the privacy/content-at-rest posture is a first-class reason against Zep Cloud.
- **ADR-0019** — the `user_facts` bi-temporal status machine is the temporal capability cited in micro-decision 2.

**Alternatives.**

- (a) **Zep Cloud (managed).** Rejected: entire memory graph leaves our DB to a third-party SaaS — against ADR-0038 + the privacy positioning — and the source of truth leaves Postgres (breaks the Replicache memory surface).
- (b) **Zep / Graphiti self-host (+ Neo4j/FalkorDB).** Rejected: a second datastore to operate, solving a traversal-scale problem single-user Alfred doesn't have; still moves the store off Postgres.
- (c) **Mem0 OSS as the store.** Rejected: a parallel store + sync against `user_facts`; its contradiction handling is *weaker* (replacement, not the supersession chain we already have). Its taxonomy is borrowed (micro-decision 4); its store is not.
- (d) **Letta (MemGPT) runtime.** Rejected: it's a whole agent runtime — adopting it means rebuilding Alfred's roll-your-own durable agent loop ([ADR-0040](#adr-0040)).

**Deferred / Open.**

- Hybrid RRF retrieval (P6) — only if pgvector recall proves insufficient; no infra change either way.
- Graph-engine benchmark — only on the multi-tenant-at-scale revisit trigger above.
