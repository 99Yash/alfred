# Zep and Graphiti — how they work, and what it would take to build one

Status: researched 2026-08-20
Scope: how Zep and Graphiti actually work, read from the Graphiti source at
commit [`10374d6`](https://github.com/getzep/graphiti/tree/10374d6044f91b9ecae3586828abb1ecbf022c4f)
(`graphiti-core` 0.29.3), the Zep arXiv paper, `help.getzep.com`, the published
`@getzep/zep-cloud` SDK, and the Mem0, Letta, Cognee and Supermemory
repositories at the commits named in Sources. No secondary write-ups were used.

**This note answers "how does it work", not "should we adopt it".** The adoption
question is already closed for Alfred by
[ADR-0058](../decisions/ADR-0058-memory-store-the-postgres-substrate-over-a.md)
(2026-06-14), which keeps memory on Postgres and rejects Zep Cloud, Zep
self-host, Mem0-as-store, and Letta. Section 0 below checks ADR-0058's factual
claims against the primary sources. Nothing here reopens the decision; one
finding strengthens it and one correction makes its cost estimate too low.

Source-code claims link to the exact file at the pinned commit and name the
function or class. Vendor claims are labelled as vendor claims. Numbers that a
vendor published about itself are marked self-reported. See "Confidence and
gaps" for what I could not verify.

## 0. How this lands against ADR-0058

ADR-0058 asked a future reader to verify one number, and the sources contradict
it in Alfred's favour.

- **"Roughly five calls per episode" is too low.** ADR-0058 estimates five LLM
  calls per episode and $50-100/month of added model spend. Reading the pipeline
  gives **3 to 5 calls for a trivial chat message and 18 to 33 for a dense
  document episode**, plus two hybrid graph searches and two query embeddings
  *per extracted edge*, all on the write path (see A3). Alfred ingests email,
  which is closer to the dense case. The ADR's cost argument holds; its figure
  understates the cost.
- **The bi-temporal claim is confirmed.** Graphiti's edge model is
  `valid_at` / `invalid_at` / `created_at` / `expired_at`, and contradicted edges
  are marked invalid rather than deleted (see A2, A4). That is the same shape as
  `user_facts.valid_from` / `valid_until` / `supersedes_id`. ADR-0058's
  "we already have it" is accurate.
- **The self-host claim is confirmed and now stronger.** Zep's own
  self-hostable community edition is "deprecated and no longer supported"
  ([FAQ](https://help.getzep.com/faq)), and Zep Cloud replaces Graphiti's graph
  store *and* its extraction, reranking and embedding models with proprietary
  ones ([zep-vs-graphiti](https://help.getzep.com/zep-vs-graphiti)). Self-hosting
  Graphiti does not get you Zep.
- **One thing ADR-0058 did not know.** Graphiti runs **no vector index**. Every
  semantic search is a full label scan with cosine evaluated per row
  ([`node_similarity_search`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/search/search_utils.py)).
  Alfred's HNSW indexes over `halfvec` are better than the engine ADR-0058
  declined to adopt.
- **What ADR-0058 got that no benchmark could tell it.** No published score
  should move this decision. Zep has printed four different LoCoMo figures for
  itself in a year, Mem0's own numbers swing nine points on retrieval depth
  alone, and an independent audit puts the dataset's scoring ceiling at 93.57% —
  below Zep's current published 94.7% (see A7).

The one genuinely reusable idea, independent of the store, is Graphiti's
three-stage entity resolution: exact name match, then MinHash/LSH with an
entropy gate, then a single batched LLM call (see A3). Alfred resolves entities
in `packages/assistant/src/knowledge/entities.ts` and could adopt that cascade
without adopting anything else.

## 0b. Where each repo actually stands

**Alfred** already has the substrate: Postgres with pgvector and HNSW indexes,
`user_facts` with the bi-temporal chain, `entities` and `entity_relations` for
the graph model, an append-only `observations` log with replayable projections
(`packages/db/src/schema/user-model.ts`), Voyage embeddings via
`packages/ai/src/embeddings.ts`, and BullMQ workers. Building "our own Zep" is
mostly a description of what exists. The unbuilt pieces are the RRF fusion path
ADR-0058 names, `identity-facts-projection-v1`, and the pending Gmail projection
activation.

**`-dimension-ai-web`, by contrast, pays for Zep and does not use it.** It
depends on `@getzep/zep-cloud@^3.10.0` (`packages/trpc/package.json:21`) and
calls exactly four operations — `create_user`, `delete_user`, `create_thread`,
`delete_thread` (`packages/events/events/memory/manage-state.event.ts:6`,
`packages/trpc/server/routers/auth.router.ts:216`). There is no call to
`thread.addMessages` and none to `thread.getUserContext`. A
`zep_ingestion_episodes` table exists in the Drizzle schema with no writer
outside the schema file, and `threads.zep_thread_created` is likewise unread.
So that repo carries the dependency and the per-episode price list without
ingesting an episode or reading a fact back. Part B's build-or-buy costing was
written against that repo, and its conclusion there is "use what you already
pay for before building anything".

---

# Part A — How Zep and Graphiti actually work

## A1. Product and architecture

### What Graphiti is

Graphiti describes itself as "A temporal graph building library" and ships as the PyPI package
`graphiti-core`, currently version `0.29.3`, licensed Apache-2.0, requiring Python 3.10+
([`pyproject.toml`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/pyproject.toml)).
Its declared hard dependencies are `pydantic`, `neo4j`, `openai`, `tenacity`, `numpy`,
`python-dotenv` and `posthog`; Anthropic, Groq, Google GenAI, Voyage, FalkorDB, Kuzu and
Neptune support are optional extras (same file). The authors are listed with `@getzep.com`
email addresses, and every source file carries the header
`Copyright 2024, Zep Software, Inc.` (for example
[`graphiti_core/edges.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/edges.py)).

### The relationship between Zep Cloud and Graphiti

The Graphiti README states this directly:

> "Graphiti is the open-source temporal context graph engine at the core of
> [Zep's](https://www.getzep.com) context infrastructure for AI agents."

and

> "Under the hood, Zep is powered by a proprietary graph database — the
> [Context Graph Engine](https://www.getzep.com/platform/context-graph-engine/) — built for
> millions of context graphs with low-latency retrieval, so production deployments don't
> require a separate third-party graph database."

([Graphiti README, section "Graphiti and Zep"](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/README.md)).

The same README carries a "Zep vs Graphiti" table. The load-bearing rows:

| Aspect | Zep | Graphiti |
|---|---|---|
| Graph database | "Proprietary Context Graph Engine … no third-party graph database vendor required" | "Bring your own third-party graph database" |
| User & conversation management | "Built-in users, threads, and message storage" | "Build your own" |
| Retrieval & performance | "Pre-configured, production-ready retrieval with sub-200ms performance at scale" | "Custom implementation required; performance depends on your setup" |
| Deployment | "Fully managed or in your cloud" | "Self-hosted only" |

([Graphiti README, "Zep vs Graphiti"](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/README.md)).
The "sub-200ms performance at scale" figure is a vendor claim on a vendor page. I found no
published methodology for it. Treat it as marketing.

Zep's own docs page [Zep vs Graphiti](https://help.getzep.com/zep-vs-graphiti) is more explicit,
and it goes further than the README. Verbatim:

> "Graphiti is the open-source temporal knowledge graph framework — the engine that turns your
> data into a temporal Context Graph. It builds one Context Graph per subject (a user, customer,
> team, or topic) and runs locally.
> Zep is agent memory at enterprise scale. It runs Graphiti inside a managed system —
> extraction, retrieval, storage, and governance on the proprietary Context Graph Engine — and
> serves millions of governed Context Graphs as one Context Lake.
> **In short: Graphiti builds the graph; Zep operates it at scale.**"

The comparison table on that page lists what Zep adds that Graphiti does not have:
"Adds Observations, graph analysis, and **proprietary extraction LLMs, reranker, and embedding
models**", plus a "**Proprietary, highly scalable Context Graph Engine graph database** and
managed runtime".

So the honest reading is: **Zep Cloud is not simply hosted Graphiti, and self-hosted Graphiti
will not reach Zep Cloud parity.** Graphiti gives you the LLM pipeline, the data model and the
retrieval algorithms. Zep Cloud replaces the graph store, the extraction models, the reranker
*and* the embedding models with proprietary versions, and adds the user/thread/message API,
Observations, Smart Context Assembly, the dashboard and the SDKs. That is a large closed
surface, not a thin hosting wrapper.

**Zep's self-hostable community edition is dead.** The FAQ states: "Zep Community Edition,
which allows you to host Zep locally, is deprecated and no longer supported"
([Zep FAQ](https://help.getzep.com/faq)). Self-hosting is available only as a commercial
"Cloud + BYOK · BYOC" Enterprise option ([Zep pricing](https://www.getzep.com/pricing)).

### Independent confirmation that Zep Cloud is Graphiti-derived

The published TypeScript SDK is strong evidence. In `@getzep/zep-cloud@3.10.0` (Apache-2.0,
already installed in `-dimension-ai-web`), the `Reranker` type is
`"rrf" | "mmr" | "node_distance" | "episode_mentions" | "cross_encoder"`
(`dist/cjs/api/types/Reranker.d.ts`), which is exactly the reranker set defined in Graphiti's
[`search_config.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/search/search_config.py)
(`EdgeReranker` / `NodeReranker`). The SDK's `EntityEdge` interface
(`dist/cjs/api/types/EntityEdge.d.ts`) is field-for-field Graphiti's `EntityEdge`: `fact`,
`validAt`, `invalidAt`, `expiredAt`, `createdAt`, `episodes`, `sourceNodeUuid`,
`targetNodeUuid`, `attributes` — compare
[`graphiti_core/edges.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/edges.py),
class `EntityEdge`. The SDK's `GraphSearchScope` is `"edges" | "nodes" | "episodes"` with the
comment "Defaults to Edges. Communities will be added in the future."
(`dist/cjs/api/types/GraphSearchScope.d.ts`), so Zep Cloud currently exposes less than
Graphiti does — Graphiti already supports community search.

### Zep Cloud API surface (from the published SDK reference)

`@getzep/zep-cloud@3.10.0`'s bundled `reference.md` lists the client methods. Grouped:

- **Graph**: `graph.add`, `graph.addBatch`, `graph.addFactTriple`, `graph.search`,
  `graph.create`, `graph.get`, `graph.update`, `graph.delete`, `graph.clone`,
  `graph.listAll`, `graph.listEntityTypes`.
- **Graph sub-resources**: `graph.edge.getByUserId` / `getByGraphId` / `get` / `delete`;
  `graph.node.getByUserId` / `getByGraphId` / `getEdges` / `getEpisodes` / `get`;
  `graph.episode.getByUserId` / `getByGraphId` / `get` / `getNodesAndEdges` / `delete`.
- **Thread**: `thread.create`, `thread.addMessages`, `thread.addMessagesBatch`,
  `thread.get`, `thread.getUserContext`, `thread.listAll`, `thread.delete`,
  `thread.message.update`.
- **User**: `user.add`, `user.get`, `user.update`, `user.delete`, `user.getNode`,
  `user.getThreads`, `user.listOrdered`, `user.warm`,
  `user.addUserSummaryInstructions` / `listUserSummaryInstructions` / `deleteUserSummaryInstructions`.
- **Project**: `project.get`.

(Source: the `reference.md` shipped inside the npm package
`@getzep/zep-cloud@3.10.0`; the same content is generated by Fern from Zep's API definition.)

The live docs list a wider surface than the SDK version we have installed: resource groups
**Thread**, **User**, **User Groups** (with Members and Policy Sets), **Context**, **Graph**
(with Edge, Episode, Node, Custom Instructions, Observations, Thread Summaries, Documents,
Document Summaries), **Project**, **Task**, **Batch**, plus an OpenAPI 3.1 spec at
`https://help.getzep.com/openapi.json` ([Zep docs index](https://help.getzep.com/llms.txt)).
Ontology is set with `graph.set_ontology(...)` and context templates with
`context.create_context_template(...)` (same source). The API base is
`https://api.getzep.com`, and the path segment stays `v2` even for the V3 SDK: "The V3 SDK
still uses `v2` in the API endpoint URL … The 'V3' refers to the SDK version, not the API path"
([February 2026 deprecation wave](https://help.getzep.com/february-2026-deprecation-wave)).

`graph.add` takes `data`, `type` (enum `text`, `json`, `message`, `fact_triple` — the same set
as Graphiti's `EpisodeType`), `user_id` **or** `graph_id`, `created_at`, `document_id`,
`metadata` ("Max 10 keys"), `source_description`, and `strict_ontology` ("When true, prevents
extraction of generic Entity nodes that do not match the configured ontology"). **It returns
HTTP 202** — ingestion is asynchronous
([graph.add reference](https://help.getzep.com/sdk-reference/graph/add-data)).

### Breaking changes we must plan around (February 2026)

Four deprecations from the [February 2026 deprecation wave](https://help.getzep.com/february-2026-deprecation-wave):

1. **Sessions → Threads.** `role_type` → `role`; the old `role` → `name`.
2. **Groups → Standalone Graphs.** `group_id` → `graph_id`. Zep's reason, verbatim: "The name
   'groups' was confusing, as these were actually arbitrary knowledge graphs." So `group_id`
   remains the Graphiti term ([graph namespacing](https://help.getzep.com/graphiti/core-concepts/graph-namespacing));
   the Zep Cloud v3 equivalent is a standalone graph created with `graph.create()`.
3. **Fact ratings are removed entirely** — the `minRating` query parameter, the
   `fact_rating_instruction` field on users/sessions/groups/graphs, `min_fact_rating` in graph
   search, and the methods for retrieving facts by rating. Replacement: "Use custom ontology
   and/or custom user summary instructions."
4. **`min_score` removed** from `graph.search()`.

Also removed: `session.end`, `session.classify`, `session.extract`,
`session.synthesize_question`, and `session.search` / `memory.search`.

The live `graph.search` also has a wider `scope` enum than our installed SDK: `edges`, `nodes`,
`episodes`, `thread_summaries`, `observations`, `auto`, plus a `max_characters` parameter for
the `auto` scope ("Defaults to 2500. Limited to 50000") and `return_raw_results`
([graph.search reference](https://help.getzep.com/sdk-reference/graph/search)).

`graph.search` accepts `query`, `limit` ("Defaults to 10. Limited to 50"), `scope`,
`reranker`, `centerNodeUuid`, `bfsOriginNodeUuids`, `mmrLambda`, `minFactRating`,
`searchFilters`, and one of `userId` or `graphId`
(`dist/cjs/api/resources/graph/client/requests/GraphSearchQuery.d.ts`). `minScore` is marked
`Deprecated`. The reranker-score semantics are documented on the type: `score` is
"sigmoid-distributed logits [0,1] when using cross_encoder reranker, or RRF ordinal rank when
using rrf reranker", and `relevance` is "an experimental rank-aligned score in [0,1] …
Only populated when using cross_encoder reranker" (`dist/cjs/api/types/EntityEdge.d.ts`).

### The context block

`thread.getUserContext(threadId, { minRating?, mode? })` returns
`ThreadContextResponse { context?: string }`. The SDK's own doc comments:

- Method description: "Returns most relevant context from the user graph (including memory
  from any/all past threads) based on the content of the past few messages of the given
  thread." (`reference.md`)
- Field description: "Context block containing relevant facts, entities, and
  messages/episodes from the user graph. Meant to be replaced in the system prompt on every
  chat turn." (`dist/cjs/api/types/ThreadContextResponse.d.ts`)
- `mode` is `"basic" | "summary"` (`dist/cjs/api/resources/thread/types/ThreadGetUserContextRequestMode.d.ts`),
  documented as "Defaults to summary mode. Use basic for lower latency"
  (`dist/cjs/api/resources/thread/client/requests/ThreadGetUserContextRequest.d.ts`).

**`mode` and `minRating` are both deprecated.** The installed SDK v3.10.0 still declares them,
but the docs say: "The `mode` parameter on `getUserContext` / `get_user_context` is being
deprecated … **The summarization logic has been removed in favor of a fast, structured context
format.**", and fact ratings (hence `minRating`) are removed entirely
([February 2026 deprecation wave](https://help.getzep.com/february-2026-deprecation-wave)).
The migration is simply to drop both arguments.

### The current documented Zep Cloud context block

Verbatim from [Retrieving context](https://help.getzep.com/retrieving-context):

```text
# This is the user summary
<USER_SUMMARY>
Emily Painter is a user with account ID Emily0e62 who uses digital art tools for creative work. ...
</USER_SUMMARY>

# These are the most relevant facts and their valid date ranges
# format: FACT (Date range: from - to)
<FACTS>
  - Emily is experiencing issues with logging in. (2024-11-14 02:13:19+00:00 - present)
  - User account Emily0e62 has a suspended status due to payment failure. (2024-11-14 02:03:58+00:00 - present)
  - Account Emily0e62 made a failed transaction of 99.99. (2024-07-30 00:00:00+00:00 - 2024-08-30 00:00:00+00:00)
</FACTS>
```

So Zep Cloud's shipped format has diverged from Graphiti's: XML-ish tags, a user summary, and
facts rendered as one-line sentences with an inline date range where a null `invalid_at` prints
as `present`. The docs add that the block "can include the user summary, facts, entities,
episodes, observations, and thread summaries" and that "Smart Context Assembly selects which
context types appear based on relevance". Six context types are defined
([Context types](https://help.getzep.com/context-types)): Facts ("a discrete, time-scoped
relationship between two entities"), Entities ("a noun … plus a narrative summary of its
history"), Episodes ("the raw text, message, or JSON the developer ingested"), Thread
summaries, Observations ("durable, evidence-backed pattern, decision, or commitment"), and User
summary ("the only type always included in default context retrieval"). Custom templates use a
`%{...}` syntax, e.g. `%{user_summary}`, `%{edges limit=10}`, `%{entities limit=5}`,
`%{episodes}` ([Context templates](https://help.getzep.com/context-templates)).

### What `getUserContext` actually does, per Zep's own FAQ

This is unusually candid and worth quoting in full
([Zep FAQ](https://help.getzep.com/faq)):

> "`thread.get_user_context` does a `graph.search` on nodes, edges, and episodes using the MMR
> reranker. It uses the most recent message as the search query. In addition, it does a `BFS` on
> the 4 most recent episodes (so it finds all nodes, edges, and episodes created by the 4 most
> recent episodes and all nodes and edges 2 connections deep)."

Two operational warnings from the same page: retrieval is quoted at "P95 < 200ms", and
ingestion lags — "Because Zep's ingestion can take a few minutes, the context block may not
include information from the last few messages", so Zep tells you to include "the last 4 to 6
messages of the thread" yourself. Also: "Typically, episodes process in less than 10 seconds,
but occasionally they can take a few minutes" and "if you add multiple episodes to a single
graph simultaneously, they must process sequentially" — the same serialization constraint we
see in the OSS code (see B2).

### The OSS context block

The OSS equivalent is `search_results_to_context_string` in
[`graphiti_core/search/search_helpers.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/search/search_helpers.py),
which emits exactly this block (verbatim from source):

```
    FACTS and ENTITIES represent relevant context to the current conversation.
    COMMUNITIES represent a cluster of closely related entities.

    These are the most relevant facts and their valid and invalid dates. Facts are considered valid
    between their valid_at and invalid_at dates. Facts with an invalid_at date of "Present" are considered valid.
    <FACTS>
            ...
    </FACTS>
    <ENTITIES>
            ...
    </ENTITIES>
    <EPISODES>
            ...
    </EPISODES>
    <COMMUNITIES>
            ...
    </COMMUNITIES>
```

Each `<FACTS>` entry is `{fact, valid_at, invalid_at}` where a null `invalid_at` is rendered
as the literal string `"Present"`; each `<ENTITIES>` entry is `{entity_name, summary}`
(same file). This is the whole "memory" contract: a string of dated fact sentences plus
entity summaries, dropped into the system prompt.

## A2. The Graphiti data model

### Node types

All nodes derive from the abstract `Node` in
[`graphiti_core/nodes.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/nodes.py),
with fields `uuid`, `name`, `group_id` ("partition of the graph"), `labels`, `created_at`.

| Class | Extra fields | Purpose |
|---|---|---|
| `EpisodicNode` | `source: EpisodeType`, `source_description`, `content` ("raw episode data"), `valid_at`, `entity_edges: list[str]`, `episode_metadata` | The raw ingested unit and the provenance record |
| `EntityNode` | `name_embedding`, `summary` ("regional summary of surrounding edges"), `attributes: dict` | A resolved entity |
| `CommunityNode` | `name_embedding`, `summary` ("region summary of member nodes") | A cluster of entities |
| `SagaNode` | `summary`, `first_episode_uuid`, `last_episode_uuid`, `last_summarized_at`, `last_summarized_episode_valid_at` | A named ordered series of episodes (newer than the paper) |

`EpisodeType` is an enum with values `message`, `json`, `text`, `fact_triple`. The docstring
specifies that `message` content "should be formatted as `actor: content`" (same file).

`SagaNode` is not in the 2025 paper and is not exposed by the Zep Cloud TS SDK v3.10.0. It is
a newer OSS addition, wired through `HAS_EPISODE` and `NEXT_EPISODE` edges and a
`summarize_saga` method
([`graphiti_core/graphiti.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/graphiti.py),
`Graphiti.summarize_saga`, `Graphiti._get_or_create_saga`).

### Edge types

From [`graphiti_core/edges.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/edges.py).
The abstract `Edge` has `uuid`, `group_id`, `source_node_uuid`, `target_node_uuid`,
`created_at`.

| Class | Graph relationship | Meaning |
|---|---|---|
| `EpisodicEdge` | `MENTIONS` | episode → entity it mentions |
| `EntityEdge` | `RELATES_TO` | entity → entity, carrying a `fact` |
| `CommunityEdge` | `HAS_MEMBER` | community → member |
| `HasEpisodeEdge` | `HAS_EPISODE` | saga → episode |
| `NextEpisodeEdge` | `NEXT_EPISODE` | episode → next episode in a saga |

(Relationship names confirmed by the index statements in
[`graphiti_core/graph_queries.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/graph_queries.py),
`get_range_indices`.)

`EntityEdge` carries the interesting fields (verbatim descriptions from the source):

```python
name: str = Field(description='name of the edge, relation name')
fact: str = Field(description='fact representing the edge and nodes that it connects')
fact_embedding: list[float] | None
episodes: list[str]  # 'list of episode ids that reference these entity edges'
expired_at: datetime | None   # 'datetime of when the node was invalidated'
valid_at: datetime | None     # 'datetime of when the fact became true'
invalid_at: datetime | None   # 'datetime of when the fact stopped being true'
reference_time: datetime | None  # 'reference timestamp from the episode that produced this edge'
attributes: dict[str, Any]
```

### The bi-temporal model

Two independent time axes live on `EntityEdge`:

- **Event time (`t_valid` / `t_invalid`)** is `valid_at` and `invalid_at`. These describe the
  world: when the fact became true and when it stopped being true. They are produced by the
  LLM from the episode text, and may be `null` when no time is stated. The extraction prompt
  is explicit: "Leave both fields `null` if no explicit or resolvable time is stated" and
  "Do **not** hallucinate or infer temporal bounds from unrelated events"
  ([`graphiti_core/prompts/extract_edges.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/prompts/extract_edges.py),
  function `edge`, "# DATETIME RULES").
- **Ingestion / system time** is `created_at` and `expired_at`. `created_at` is set from
  `utc_now()` when the edge object is built
  ([`edge_operations.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/utils/maintenance/edge_operations.py),
  `extract_edges`). `expired_at` is set from `utc_now()` at the moment the system learns the
  fact is no longer current (same file, `resolve_extracted_edge` and
  `resolve_edge_contradictions`).

The distinction is made purely by which field is written and by *what clock* writes it:
`valid_at` / `invalid_at` come from the LLM reading the text and are anchored to the
episode's `valid_at` (`reference_time`); `created_at` / `expired_at` come from `utc_now()`.
`EntityEdge.reference_time` records which episode's timestamp anchored the event-time
resolution, so you can audit an event-time value against its provenance.

`EpisodicNode.valid_at` is the episode's own reference time (the caller passes
`reference_time` to `add_episode`), and `EpisodicNode.created_at` is wall clock — the same
split one level up
([`graphiti.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/graphiti.py),
`Graphiti.add_episode`).

The retrieval-time contract exposed to the LLM is: a fact is valid between `valid_at` and
`invalid_at`; `invalid_at == null` renders as `"Present"` and means still valid
(`search_helpers.py`, quoted above). Note the important subtlety: **`expired_at` is not
surfaced in the context block at all**, and the context block does not filter out invalidated
facts — it renders their dates and lets the LLM decide.

## A3. The ingestion pipeline

Entry point:
[`Graphiti.add_episode`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/graphiti.py).
Its own docstring sets the operating expectation:

> "It is recommended to run this method as a background process, such as in a queue.
> It's important that each episode is added sequentially and awaited before adding
> the next one."

### Step order

1. **Fetch previous episodes for context.** `retrieve_episodes(reference_time,
   last_n=RELEVANT_SCHEMA_LIMIT, ...)` where `RELEVANT_SCHEMA_LIMIT = 10`
   ([`search_utils.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/search/search_utils.py)).
   Callers may instead pass explicit `previous_episode_uuids`.
2. **Entity extraction — 1 LLM call.** `extract_nodes` in
   [`node_operations.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/utils/maintenance/node_operations.py)
   builds a context of `episode_content`, `episode_timestamp`, `previous_episodes`,
   `entity_types`, `source_description`, then `_call_extraction_llm` dispatches on
   `episode.source` to one of `extract_nodes.extract_message`, `extract_nodes.extract_text`,
   or `extract_nodes.extract_json`, with `response_model=ExtractedEntities`. Empty names are
   dropped. `_collapse_exact_duplicate_extracted_nodes` then merges same-episode duplicates
   by normalised name — no LLM.
3. **Entity resolution — 0 or 1 LLM call.** `resolve_extracted_nodes` (same file) is a
   three-stage cascade:
   - `_semantic_candidate_search` embeds every extracted node *name* in one batch
     (`embedder.create_batch`) and runs `node_similarity_search` per name with
     `NODE_DEDUP_CANDIDATE_LIMIT = 15` and `NODE_DEDUP_COSINE_MIN_SCORE = 0.6`.
   - `_resolve_with_similarity` in
     [`dedup_helpers.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/utils/maintenance/dedup_helpers.py)
     tries deterministic resolution: exact normalised-name match first (always attempted); if
     exactly one candidate matches, resolve; if more than one matches, escalate. Otherwise an
     entropy gate `_has_high_entropy` (Shannon entropy over characters, threshold
     `_NAME_ENTROPY_THRESHOLD = 1.5`, `_MIN_NAME_LENGTH = 6`, `_MIN_TOKEN_COUNT = 2`) decides
     whether fuzzy matching is trustworthy. If it is, MinHash over character 3-gram shingles
     (`_MINHASH_PERMUTATIONS = 32`, `_MINHASH_BAND_SIZE = 4`) with LSH banding produces
     candidates, and a Jaccard score at or above `_FUZZY_JACCARD_THRESHOLD = 0.9` resolves.
   - Anything still unresolved goes to **one** batched LLM call,
     `dedupe_nodes.nodes`, with `response_model=NodeResolutions`
     (`_resolve_with_llm`). The prompt asks for one resolution per entity with
     `duplicate_candidate_id` or `-1`
     ([`prompts/dedupe_nodes.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/prompts/dedupe_nodes.py),
     function `nodes`). The code defensively range-checks the returned ids.
   This cascade is the single best engineering idea in the codebase: the deterministic path
   handles the common case for free, and only ambiguous names cost a token.
4. **Edge (fact) extraction — 1 LLM call.** `extract_edges` in
   [`edge_operations.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/utils/maintenance/edge_operations.py)
   sends `previous_episodes`, `episode_content`, the resolved `ENTITIES` list, a
   `REFERENCE_TIME`, and optional `FACT_TYPES`, with `extract_edges_max_tokens = 16384`. The
   response model has `source_entity_name`, `target_entity_name`, `relation_type`
   (SCREAMING_SNAKE_CASE), `fact`, `valid_at`, `invalid_at`, `episode_indices`
   ([`prompts/extract_edges.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/prompts/extract_edges.py),
   class `Edge`). Names not present in the `ENTITIES` list cause the edge to be dropped
   ("Could not find source or target node for extracted edge").
   **Note that `valid_at` / `invalid_at` are produced here, in the same call as the fact.**
5. **Edge resolution and invalidation — 1 LLM call per extracted edge.**
   `resolve_extracted_edges` (same file):
   - exact-duplicate collapse on `(source_uuid, target_uuid, normalized_fact)` — no LLM;
   - `EntityEdge.get_between_nodes` for each extracted edge, giving the same-endpoint
     candidate set;
   - **two hybrid searches per extracted edge**, both with `config=EDGE_HYBRID_SEARCH_RRF`:
     one filtered to the same-endpoint candidates (duplicate candidates) and one unfiltered
     (invalidation candidates). Overlap is removed from the invalidation list;
   - `resolve_extracted_edge` per edge, which calls `dedupe_edges.resolve_edge` with
     `model_size=ModelSize.small` and `response_model=EdgeDuplicate`. A fast path first: if a
     candidate has identical endpoints and an identical normalised `fact`, reuse it with no
     LLM call at all.
6. **Temporal extraction — 0 or 1 small LLM call per new edge.** `_extract_edge_timestamps`
   (same file) is a fallback: it returns immediately "if the edge already has timestamps set
   (e.g., from the extraction prompt …) or if no reference time is available". Otherwise it
   calls `extract_edges.extract_timestamps` with `model_size=ModelSize.small` and
   `response_model=EdgeTimestamps`. Duplicated edges keep their existing timestamps
   (`if resolved_edge.uuid == extracted_edge.uuid:` guard).
7. **Attribute extraction — optional, per node and per edge.** Only when custom Pydantic
   entity/edge types with fields are configured. `_extract_entity_attributes` calls
   `extract_nodes.extract_attributes` (small model) per node;
   `resolve_extracted_edge` calls `extract_edges.extract_attributes` (small model) per edge.
   Merge semantics differ: nodes use `merge_mode='overlay'`, edges use `merge_mode='replace'`,
   documented inline in `node_operations.py`. Edges with no matching schema have their
   `attributes` reset to `{}`.
8. **Entity summaries — 0 to ceil(N/30) small LLM calls.**
   `_extract_entity_summaries_batch` in `node_operations.py`. There is a no-LLM shortcut:
   the node's existing summary plus the new edge facts are concatenated, and "If summary is
   close to the persisted limit, use it directly (append edge facts, no LLM call)" — the
   threshold is `len(summary_with_edges) <= MAX_SUMMARY_CHARS * 2`. Remaining nodes are
   partitioned into "flights" of `MAX_NODES = 30` and each flight is one call to
   `extract_nodes.extract_summaries_batch` (small model).
9. **Embedding generation.** `create_entity_node_embeddings` embeds node names;
   `create_entity_edge_embeddings` embeds edge `fact` strings. `EntityEdge.generate_embedding`
   embeds `self.fact` with newlines replaced. Note `resolve_extracted_edges` calls
   `create_entity_edge_embeddings` up to three times over overlapping sets (once on
   `extracted_edges` at the top, then on `resolved_edges` and `invalidated_edges` at the
   bottom).
10. **Persist.** `add_nodes_and_edges_bulk` writes episodes, `MENTIONS` edges, entity nodes
    and `RELATES_TO` edges. If `store_raw_episode_content` is false the episode `content` is
    blanked before the write (`graphiti.py`, `_process_episode_data`).
11. **Communities — only if `update_communities=True`.** Default is `False`
    (`add_episode` signature). See A3.3.

### Which steps need an LLM

| Step | LLM? | Prompt name | Model size |
|---|---|---|---|
| Entity extraction | Yes, always | `extract_nodes.extract_message` / `.extract_text` / `.extract_json` | main |
| Entity dedup, deterministic pass | No | — | — |
| Entity dedup, escalation | Only if unresolved | `dedupe_nodes.nodes` | main |
| Edge extraction | Yes, always | `extract_edges.edge` | main |
| Edge dedup / contradiction | Per edge, unless graph empty or verbatim fast-path hit | `dedupe_edges.resolve_edge` | small |
| Edge timestamps | Per new edge, only if extraction left them null | `extract_edges.extract_timestamps` | small |
| Node attributes | Only with custom entity types that have fields | `extract_nodes.extract_attributes` | small |
| Edge attributes | Only with custom edge types that have fields | `extract_edges.extract_attributes` | small |
| Node summaries | Only for nodes that miss the concat shortcut | `extract_nodes.extract_summaries_batch` | small |
| Community summaries | Only if `update_communities=True` or `build_communities()` | `summarize_nodes.summarize_pair`, `summarize_nodes.summary_description` | main |
| Contradiction *arithmetic* | **No** | — | — |

(All prompt names are the literal `prompt_name=` arguments in
[`node_operations.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/utils/maintenance/node_operations.py),
[`edge_operations.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/utils/maintenance/edge_operations.py)
and
[`community_operations.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/utils/maintenance/community_operations.py).)

There is also a newer **combined** path,
[`combined_extraction.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/utils/maintenance/combined_extraction.py),
which extracts nodes and edges in a single call (`extract_nodes_and_edges.extract_message`,
`response_model=CombinedExtraction`) and batches timestamps
(`extract_edges.extract_timestamps_batch`). It is not what `add_episode` calls in 0.29.3;
`add_episode` uses the separate `extract_nodes` and `extract_edges` path.

### How many LLM calls per episode

Let `N` = entities extracted, `E` = edges extracted, `U` = entities that survive
deterministic dedup unresolved.

Baseline (no custom types, `update_communities=False`):

```
calls = 1                       # extract_nodes.*
      + (1 if U > 0 else 0)     # dedupe_nodes.nodes
      + 1                       # extract_edges.edge
      + E'                      # dedupe_edges.resolve_edge, E' = edges with candidates and no verbatim hit
      + T                       # extract_edges.extract_timestamps, T = new edges the extractor left undated
      + S                       # ceil(nodes_needing_summary / 30)
```

For a short chat message with `N=2, E=1`: **3 to 5 calls**. For a dense document episode with
`N=12, E=15` in a populated graph: **roughly 18 to 33 calls**, most of them on the small
model. Add `N + E` more small calls if you use custom entity and edge types with fields.
I did not find a published per-episode call count from Zep, so these figures are my reading
of the code, not a vendor number.

Non-LLM write-path cost matters as much: **2 hybrid graph searches per extracted edge**, plus
one `get_between_nodes` per edge, plus one embedding batch for node names, plus 2 query
embeddings per extracted edge (each `search()` embeds its query unless a vector is passed —
[`search.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/search/search.py),
`search`), plus the edge fact embeddings. Concurrency is bounded by
`SEMAPHORE_LIMIT`, default 20
([`graphiti_core/helpers.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/helpers.py)),
overridable per-instance as `max_coroutines`.

Default models (OSS defaults, not Zep Cloud's): `DEFAULT_MODEL = 'gpt-5.5'` and
`DEFAULT_SMALL_MODEL = 'gpt-4.1-nano'`
([`llm_client/openai_base_client.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/llm_client/openai_base_client.py));
Anthropic default is `'claude-haiku-4-5-latest'`
([`llm_client/anthropic_client.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/llm_client/anthropic_client.py)).
`DEFAULT_MAX_TOKENS = 16384`
([`llm_client/config.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/llm_client/config.py)).
The README warns that Graphiti "works best with LLM services that support Structured Output"
and that other services "may result in incorrect output schemas and ingestion failures".

### A3.3 Community detection

Yes, it is label propagation, implemented by hand. `label_propagation` in
[`community_operations.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/utils/maintenance/community_operations.py)
carries its own spec as a comment:

```python
# 1. Start with each node being assigned its own community
# 2. Each node will take on the community of the plurality of its neighbors
# 3. Ties are broken by going to the largest community
# 4. Continue until no communities change during propagation
```

Neighbour votes are weighted by `Neighbor.edge_count`, not by a plain count. Then
`build_community` produces the community summary by a **binary tournament of LLM calls**: it
repeatedly pairs summaries and calls `summarize_pair` until one summary remains, then calls
`generate_summary_description` for the name. For a cluster of `k` entities that is `k-1`
`summarize_nodes.summarize_pair` calls plus one `summarize_nodes.summary_description` call.
`build_communities` bounds concurrency with `MAX_COMMUNITY_BUILD_CONCURRENCY = 10`. This is
expensive, which is presumably why `add_episode`'s `update_communities` defaults to `False`.

## A4. Fact invalidation and contradiction handling

Two mechanisms cooperate. The LLM decides *what contradicts what*; deterministic code decides
*what gets written*.

### The LLM's job

`dedupe_edges.resolve_edge` in
[`prompts/dedupe_edges.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/prompts/dedupe_edges.py)
receives three blocks: `<EXISTING FACTS>` (same-endpoint duplicate candidates),
`<FACT INVALIDATION CANDIDATES>` (broader search results), and the `<NEW FACT>`. Indices are
continuous across the two lists. It returns `EdgeDuplicate { duplicate_facts: list[int],
contradicted_facts: list[int] }`. The constraint is stated in the prompt: "duplicate_facts:
ONLY idx values from EXISTING FACTS"; "contradicted_facts: idx values from EITHER list". The
few-shot examples are worth quoting because they define the semantics:

```
EXISTING FACT: idx=1, "Alice works at Acme Corp as a software engineer"
NEW FACT: "Alice works at Acme Corp as a senior engineer"
Result: duplicate_facts=[], contradicted_facts=[1] (same relationship but updated title — contradiction, NOT a duplicate)

EXISTING FACT: idx=2, "Bob ran 5 miles on Tuesday"
NEW FACT: "Bob ran 3 miles on Wednesday"
Result: duplicate_facts=[], contradicted_facts=[] (different events on different days — neither duplicate nor contradiction)
```

The system message is `'You are a fact deduplication assistant. NEVER mark facts with key
differences as duplicates.'`

### The deterministic job

`resolve_edge_contradictions(resolved_edge, invalidation_candidates)` in
[`edge_operations.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/utils/maintenance/edge_operations.py)
is pure arithmetic on the four timestamps. Paraphrasing the code exactly:

- **Skip** (no invalidation) if the candidate already ended before the new fact started
  (`edge.invalid_at <= resolved_edge.valid_at`), or if the new fact ended before the candidate
  started (`resolved_edge.invalid_at <= edge.valid_at`). Non-overlapping intervals do not
  contradict.
- **Invalidate the old edge** if `edge.valid_at < resolved_edge.valid_at`. It writes:
  `edge.invalid_at = resolved_edge.valid_at` and
  `edge.expired_at = edge.expired_at if edge.expired_at is not None else utc_now()`.
- Any candidate with a `null` `valid_at` on either side falls through all three branches and
  is **not** invalidated. Undated facts are never expired by this path.

Separately, in `resolve_extracted_edge`, the *new* edge can be the loser. Candidates are
sorted by `valid_at` (nulls last), and if some candidate's `valid_at` is later than the new
edge's `valid_at`, the new edge is expired on arrival:

```python
resolved_edge.invalid_at = candidate.valid_at
resolved_edge.expired_at = now
```

Also, if the extractor gave the edge an `invalid_at` but no `expired_at`, the code sets
`resolved_edge.expired_at = now`.

**What is written.** Nothing is deleted. The old edge keeps its `fact`, `valid_at`,
`created_at` and `episodes`; it gains an `invalid_at` (event time = when the successor became
true) and an `expired_at` (system time = now). Both `resolved_edges` and `invalidated_edges`
are persisted: `entity_edges = resolved_edges + invalidated_edges` in `add_episode`
([`graphiti.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/graphiti.py)).

**Honest limitation.** Invalidation only fires when both edges have `valid_at` values, and the
new edge's `valid_at` must be strictly later. Since the extraction prompt is instructed to
leave timestamps null when nothing is stated, a large fraction of real conversational facts
will have `valid_at` set to the episode timestamp (the prompt says "If the fact is ongoing
(present tense), set `valid_at` to the timestamp of the episode") — so in practice most chat
facts *are* dated, and ordering works out. But facts drawn from undated documents will not
invalidate each other.

## A5. Retrieval and search

### The three retrieval methods

From [`search_config.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/search/search_config.py):

- `EdgeSearchMethod`: `cosine_similarity`, `bm25`, `bfs` (`'breadth_first_search'`)
- `NodeSearchMethod`: `cosine_similarity`, `bm25`, `bfs`
- `EpisodeSearchMethod`: `bm25` only
- `CommunitySearchMethod`: `cosine_similarity`, `bm25`

Each configured method runs as a parallel task with candidate limit `2 * limit`
([`search.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/search/search.py),
`edge_search` / `node_search`). Defaults: `DEFAULT_SEARCH_LIMIT = 10`,
`DEFAULT_MIN_SCORE = 0.6`, `DEFAULT_MMR_LAMBDA = 0.5`, `MAX_SEARCH_DEPTH = 3`
(`search_config.py`, `search_utils.py`).

The **semantic** leg is a Cypher scan, not an index lookup. The generated query is literally:

```cypher
MATCH (n:Entity)
<filters>
WITH n, vector.similarity.cosine(n.name_embedding, $search_vector) AS score
WHERE score > $min_score
RETURN <fields>
ORDER BY score DESC
LIMIT $limit
```

(`search_utils.py`, `node_similarity_search`; the cosine function is chosen per backend by
`get_vector_cosine_func_query` in
[`graph_queries.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/graph_queries.py)).
For Neptune the driver fetches all embeddings and computes cosine in Python
(`calculate_cosine_similarity` loop in the same function). See A6 on the absence of vector
indices.

The **BFS** leg (`edge_bfs_search` / `node_bfs_search`) requires `bfs_origin_node_uuids` and
returns empty if none are supplied or if `bfs_max_depth < 1` (`search_utils.py`).

### The rerankers

`EdgeReranker` and `NodeReranker` both offer `rrf`, `node_distance`, `episode_mentions`,
`mmr`, `cross_encoder`; `EpisodeReranker` offers `rrf` and `cross_encoder`;
`CommunityReranker` offers `rrf`, `mmr`, `cross_encoder` (`search_config.py`).

- **RRF** — `rrf(results, rank_const=1, min_score=0)` in `search_utils.py`:
  `scores[uuid] += 1 / (i + rank_const)` per result list, then sort descending. Note
  `rank_const=1`, not the more common 60.
- **MMR** — `maximal_marginal_relevance` in `search_utils.py`. It L2-normalises candidate
  vectors, builds the full pairwise similarity matrix, then scores
  `mmr = mmr_lambda * dot(query, candidate) + (mmr_lambda - 1) * max_sim`. This requires
  loading embeddings for all candidates first (`get_embeddings_for_edges`). It is O(k²) in
  candidates.
- **Cross-encoder** — RRF first, take the top `2 * limit`, then `cross_encoder.rank(query,
  facts)` (`search.py`, `edge_search`). Two implementations ship:
  `OpenAIRerankerClient` in
  [`cross_encoder/openai_reranker_client.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/cross_encoder/openai_reranker_client.py)
  is *not* a real cross-encoder — it issues one chat completion **per passage** asking
  `Respond with "True" if PASSAGE is relevant to QUERY and "False" otherwise`, with
  `max_tokens=1`, `logit_bias={'6432': 1, '7983': 1}`, `logprobs=True, top_logprobs=2`, and
  uses `np.exp(top_logprobs[0].logprob)` as the score. That is `k` LLM calls per search.
  `BGERerankerClient` in
  [`cross_encoder/bge_reranker_client.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/cross_encoder/bge_reranker_client.py)
  is a genuine local cross-encoder: `CrossEncoder('BAAI/bge-reranker-v2-m3')`. A Gemini
  variant also exists.
- **node_distance** — requires `center_node_uuid` or raises `SearchRerankerError`. RRF first,
  then `node_distance_reranker` scores candidate source nodes by whether they are directly
  adjacent to the centre node:
  `MATCH (center:Entity {uuid: $center_uuid})-[:RELATES_TO]-(n:Entity {uuid: node_uuid})
   RETURN 1 AS score`. Edges are then re-expanded from their reranked source nodes
  (`search.py`, `edge_search`).
- **episode_mentions** — in the code path this reuses the RRF branch, then applies a final
  sort: `reranked_edges.sort(reverse=True, key=lambda edge: len(edge.episodes))`
  (`search.py`, `edge_search`). It is a recency/salience proxy: facts mentioned in more
  episodes rank higher.

### Recipes

[`search_config_recipes.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/search/search_config_recipes.py)
exports 16 prebuilt `SearchConfig` constants: `COMBINED_HYBRID_SEARCH_{RRF,MMR,CROSS_ENCODER}`,
`EDGE_HYBRID_SEARCH_{RRF,MMR,NODE_DISTANCE,EPISODE_MENTIONS,CROSS_ENCODER}`,
`NODE_HYBRID_SEARCH_{RRF,MMR,NODE_DISTANCE,EPISODE_MENTIONS,CROSS_ENCODER}`,
`COMMUNITY_HYBRID_SEARCH_{RRF,MMR,CROSS_ENCODER}`. The ingestion path itself uses
`EDGE_HYBRID_SEARCH_RRF` for its dedup and invalidation lookups (`edge_operations.py`,
`resolve_extracted_edges`).

`Graphiti.search()` is the simple facade (returns edges only); `Graphiti.search_()` takes a
full `SearchConfig` and returns `SearchResults` with per-scope lists and reranker scores
(`graphiti.py`).

### Context assembly

`search_results_to_context_string` — quoted verbatim in A1 above. Zep Cloud's equivalent is
`thread.getUserContext`, with `mode: "basic" | "summary"` and `minRating`.

## A6. Storage backends

`GraphProvider` in
[`driver/driver.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/driver/driver.py)
is `NEO4J`, `FALKORDB`, `KUZU`, `NEPTUNE`. Version requirements from the README: "Neo4j 5.26
/ FalkorDB 1.1.2 / Amazon Neptune Database Cluster or Neptune Analytics Graph + Amazon
OpenSearch Serverless collection (serves as the full text search backend) / Kuzu 0.11.2
(**deprecated**, see below)".

**Kuzu is deprecated.** The README says: "**Kuzu is deprecated** and will be removed in a
future release — the upstream Kuzu project is no longer maintained. New projects should use
Neo4j or FalkorDB. The driver still ships for now but emits a `DeprecationWarning`."

### Indices created

`build_indices_and_constraints` on `Graphiti` delegates to the driver, which uses
`get_range_indices` and `get_fulltext_indices` from
[`graph_queries.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/graph_queries.py).

*Range indices (Neo4j default branch)* — 27 statements. `uuid` on `Entity`, `Episodic`,
`Community`, `Saga` and on the `RELATES_TO`, `MENTIONS`, `HAS_MEMBER`, `HAS_EPISODE`,
`NEXT_EPISODE` relationships; `group_id` on the same set; plus `Entity.name`, `Saga.name`,
`Entity.created_at`, `Episodic.created_at`, `Episodic.valid_at`, `RELATES_TO.name`,
`RELATES_TO.created_at`, `RELATES_TO.expired_at`, `RELATES_TO.valid_at`,
`RELATES_TO.invalid_at`. FalkorDB uses composite indices instead. Kuzu returns `[]` (no range
indices).

*Full-text indices (Neo4j)* — four:
`episode_content` on `[e.content, e.source, e.source_description, e.group_id]`;
`node_name_and_summary` on `[n.name, n.summary, n.group_id]`;
`community_name` on `[n.name, n.group_id]`;
`edge_name_and_fact` on `()-[e:RELATES_TO]-()` `[e.name, e.fact, e.group_id]`.
FalkorDB creates the equivalents via `db.idx.fulltext.createNodeIndex` with a `STOPWORDS`
list; Kuzu via `CALL CREATE_FTS_INDEX(...)`; Neptune uses OpenSearch Serverless indices
(`aoss_indices` and `create_aoss_indices` in
[`driver/neptune_driver.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/driver/neptune_driver.py)).

**Constraints: none.** `grep -rn 'CONSTRAINT' graphiti_core/` returns nothing at this commit,
despite the method being named `build_indices_and_constraints`. Uniqueness on `uuid` is not
enforced by the database.

### Vector index usage: there is none

`grep -rn 'VECTOR INDEX\|CREATE_VECTOR_INDEX\|db.index.vector' graphiti_core/` returns
nothing at this commit. Embeddings are stored as plain properties and scanned:

- Neo4j / FalkorDB: `vector.similarity.cosine(...)` / `vec.cosineDistance(...)` evaluated per
  matched row (`get_vector_cosine_func_query` in `graph_queries.py`).
- Kuzu: `name_embedding FLOAT[]` and `fact_embedding FLOAT[]` are declared as plain arrays in
  the `CREATE NODE TABLE` statements
  ([`driver/kuzu_driver.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/driver/kuzu_driver.py)),
  with `array_cosine_similarity` used at query time. No HNSW index.
- Neptune: embeddings are pulled to the client and scored in Python
  (`node_similarity_search`, Neptune branch).

This is the most important scaling fact in the codebase. Every semantic search is
`O(nodes in the group_id filter)`. Because entity resolution issues one similarity search per
extracted entity name, and edge resolution issues two hybrid searches per extracted edge,
write cost grows with graph size. Zep's proprietary Context Graph Engine presumably fixes
exactly this — which is why the README's "Retrieval & performance" row says Graphiti
self-hosters get "performance depends on your setup".

### Multi-tenancy

`group_id` is the partition key on every node and edge, is indexed, and is included in the
full-text index fields. `validate_group_id` runs on write, and `add_episode` will *rebind the
driver to a database named after the group id* when `group_id != self.driver._database`:

```python
if group_id != self.driver._database:
    self.driver = self.driver.clone(database=group_id)
    self.clients.driver = self.driver
```

(`graphiti.py`, `add_episode`). That is a shared-mutable-state pattern on a long-lived
`Graphiti` instance — a real hazard if you share one instance across tenants and requests.
There is also a `graphiti_core/namespaces/` package. Isolation is logical, not physical,
unless you map groups to databases.

### Telemetry

Graphiti ships PostHog telemetry **enabled by default**:
`env_value = os.environ.get(TELEMETRY_ENV_VAR, 'true').lower()` with
`TELEMETRY_ENV_VAR = 'GRAPHITI_TELEMETRY_ENABLED'`, a hard-coded public PostHog key, and an
anonymous id cached at `~/.cache/graphiti/telemetry_anon_id`
([`telemetry/telemetry.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/telemetry/telemetry.py)).
Set `GRAPHITI_TELEMETRY_ENABLED=false` if we ever deploy this.

## A7. The academic claims — precise, and skeptical

### The paper

**"Zep: A Temporal Knowledge Graph Architecture for Agent Memory"**, by Preston Rasmussen,
Pavlo Paliychuk, Travis Beauvais, Jack Ryan and Daniel Chalef
([arXiv:2501.13956](https://arxiv.org/abs/2501.13956)). The arXiv submission history reads
"[v1] Mon, 20 Jan 2025 16:52:48 UTC (22 KB)". **There is only a v1** — no revision, no errata.
Full text: [arXiv HTML v1](https://arxiv.org/html/2501.13956v1).

**There is no Graphiti paper.** Zep's own research repo lists exactly one publication
([getzep/zep-papers README](https://github.com/getzep/zep-papers)). Graphiti's README points at
2501.13956 as "our paper". The earliest Graphiti announcement is a blog post
([Graphiti: Knowledge Graphs for Agents, 28 Aug 2024](https://blog.getzep.com/graphiti-knowledge-graphs-for-agents/)).

The abstract claims MemGPT is beaten "94.8% vs 93.4%" and that on LongMemEval Zep shows
"accuracy improvements of up to 18.5% while simultaneously reducing response latency by 90%".
Both need unpacking.

### DMR (Deep Memory Retrieval)

**What it is.** A benchmark "established by the MemGPT team". 500 conversations, "each
containing 5 chat sessions with up to 12 messages per session", one question/answer pair each —
so roughly 60 messages per conversation and 500 questions total. Zep's method: ingest the
conversations, retrieve "the top 10 most relevant nodes and edges", and have "an LLM judge"
compare against golden answers ([arXiv:2501.13956v1](https://arxiv.org/html/2501.13956v1)).

**Table 1, verbatim:**

| Memory | Model | Score |
|---|---|---|
| Recursive Summarization† | gpt-4-turbo | 35.3% |
| Conversation Summaries | gpt-4-turbo | 78.6% |
| MemGPT† | gpt-4-turbo | 93.4% |
| Full-conversation | gpt-4-turbo | 94.4% |
| **Zep** | gpt-4-turbo | **94.8%** |
| Conversation Summaries | gpt-4o-mini | 88.0% |
| Full-conversation | gpt-4o-mini | 98.0% |
| **Zep** | gpt-4o-mini | **98.2%** |

"† Results reported in [3]" — the MemGPT and Recursive Summarization rows are **cited from
MemGPT's own paper, not reproduced by Zep**. The authors state: "We were unable to reproduce
MemGPT's results using gpt-4o-mini due to insufficient methodological details in their published
work."

**What was actually measured.** The only same-harness comparison is Zep 94.8% versus
full-conversation 94.4% — **+0.4 points on 500 questions, about two questions.** On gpt-4o-mini
it is 98.2% versus 98.0%, about one question. There are no confidence intervals, no variance,
and no repeated runs reported for DMR.

**The authors themselves dismiss the benchmark**, verbatim: "each conversation contains only 60
messages, easily fitting within current LLM context windows"; "The evaluation relies exclusively
on single-turn, fact-retrieval questions that fail to assess complex memory understanding";
"Many questions contain ambiguous phrasing"; "Most critically, the dataset poorly represents
real-world enterprise use cases for LLM agents"; "The high performance achieved by simple
full-context approaches using modern LLMs further highlights the benchmark's inadequacy for
evaluating memory systems." Treat DMR as evidence of nothing.

### LongMemEval

**Subset:** LongMemEval_s, conversations averaging "approximately 115,000 tokens in length".
Six question types: "single-session-user, single-session-assistant, single-session-preference,
multi-session, knowledge-update, and temporal-reasoning", which the authors note "are not
uniformly distributed throughout the dataset". **Models: gpt-4o-mini and gpt-4o only — there is
no o1-mini in the paper.** Judge: "we employed GPT-4o with the question-specific prompts
provided in [7]". Baseline: full-context.

**MemGPT is not in this table at all.** Verbatim: "we attempted to evaluate MemGPT using the
LongMemEval dataset … **However, we were unable to achieve successful question responses using
this approach.**"

**Table 2, verbatim:**

| Memory | Model | Score | Latency | Latency IQR | Avg Context Tokens |
|---|---|---|---|---|---|
| Full-context | gpt-4o-mini | 55.4% | 31.3 s | 8.76 s | 115k |
| **Zep** | gpt-4o-mini | **63.8%** | **3.20 s** | 1.31 s | **1.6k** |
| Full-context | gpt-4o | 60.2% | 28.9 s | 6.01 s | 115k |
| **Zep** | gpt-4o | **71.2%** | **2.58 s** | 0.684 s | **1.6k** |

Table 3 gives the per-type breakdown. The two regressions are real and the authors flag them:
single-session-assistant drops from 94.6% to 80.4% on gpt-4o (−17.7% relative) and from 81.8%
to 75.0% on gpt-4o-mini (−9.06%); knowledge-update drops from 76.9% to 74.4% on gpt-4o-mini. The
largest gains are single-session-preference (20.0% → 56.7% on gpt-4o) and temporal-reasoning
(45.1% → 62.4%).

### What was actually measured — read this before quoting any number

1. **The "90% latency reduction" is not a retrieval claim.** 31.3 s → 3.20 s is *end-to-end
   response* latency, dominated by the LLM reading 115k tokens versus 1.6k. It is close to a
   restatement of "we sent 1.4% of the tokens". Zep's own blog says Zep used "less than 2% of the
   baseline tokens" ([State of the Art in Agent Memory](https://blog.getzep.com/state-of-the-art-agent-memory/)).
2. **The comparison excludes ingestion entirely.** Token counts are query-time prompt tokens.
   The paper reports no ingestion cost, no ingestion latency and no ingestion token spend for
   building a graph out of a 115k-token conversation. A full-context baseline has zero build
   cost. Given the per-episode LLM call counts in A3, this is the dominant term for us and the
   paper does not measure it.
3. **The percentages are relative, not absolute.** "18.5% improvement" is 60.2% → 71.2%, i.e.
   **+11.0 percentage points**. (Note (71.2−60.2)/60.2 = 18.27%, so the stated 18.5% does not
   reproduce exactly from the rounded table; the gpt-4o-mini figure of 15.2% does.)
4. **Network latency was one-sided, by the authors' own admission**, verbatim: "We performed
   testing using a consumer laptop from a residential location in Boston, MA, connecting to Zep's
   service hosted in AWS us-west-2. This distributed architecture introduced additional network
   latency when evaluating Zep's performance, though this latency was not present in our baseline
   evaluations." That direction favours the baseline, so the latency gap is if anything
   understated — but it also means neither number is a clean measurement.
5. **No accuracy variance anywhere.** Latency IQR is given; accuracy has no error bars and no
   repeated runs. LongMemEval_s is about 500 questions, so one percentage point is about five
   questions.
6. **Zep's retrieval was tuned; the baseline had nothing to tune.** Zep's own later work shows
   LoCoMo accuracy moving roughly 10 points as retrieval depth changes (see below). The reported
   figure is one point on a tuning curve.
7. **Self-evaluation, LLM judge, no independent replication.** All authors are Zep employees and
   the judge is GPT-4o. The paper explicitly asks for outside replication: "We look forward to
   seeing evaluations of this benchmark by other research teams." I found none.
8. **A probable table error.** In Table 3, `single-session-user` shows identical values for
   gpt-4o-mini and gpt-4o (81.4% → 92.9%, 14.1% ↑). One row looks duplicated. No errata exists
   and the paper has no v2.

### The current vendor benchmark page supersedes the paper — and is not comparable to it

[getzep.com/research](https://www.getzep.com/research/) (fetched 2026-08-20) publishes much
higher numbers on different benchmarks with a different latency definition:

- **LoCoMo**: accuracy **94.7%** ("1,459 / 1,540 correct"); retrieval latency **87 / 155 ms**
  (p50 / p95); median context **5,760 tokens**. By category: single-hop 96.4%, temporal 95.6%,
  multi-hop 94.0%, open-domain 79.2%.
- **LongMemEval**: accuracy **90.2%** ("451 / 500 correct"); retrieval latency **104 / 162 ms**;
  median context **4,408 tokens**.
- **Auto search** (a single API call): accuracy **86.5%**; latency **115 / 173 ms**; median
  context **2,680 tokens**.

Methodology, verbatim: "Reader: **gpt-5.4** (reasoning = medium). Judge: **gpt-5.4** with
chain-of-thought grading. Multi-scope retrieval depth: 20 edges, 10 nodes, 10 episodes, 5 thread
summaries, 5 observations, cross-encoder reranking. Auto search at `max_characters=10000`. Run
on 1,540 LoCoMo questions and 500 LongMemEval questions. 0 failed tests on either benchmark."

Four caveats that matter more than the numbers:

- **Latency here is retrieval-only**, not end-to-end response latency as in the paper. The 155 ms
  figure and the 2.58 s figure measure different things and must never be compared.
- **The reader model changed from gpt-4o to gpt-5.4.** The jump on LongMemEval from 71.2% to
  90.2% conflates two years of model progress with Zep improvements. It is not attributable.
- **No baseline is published on that page.** No full-context comparison, no error bars.
- **The headline results use five parallel searches** composed client-side, which is not the
  default `get_user_context` path and costs five API calls. The single-call number is the lower
  **86.5%**.

The most methodologically useful Zep publication is
[The Retrieval Tradeoff](https://blog.getzep.com/the-retrieval-tradeoff-what-50-experiments-taught-us-about-context-engineering/)
(Daniel Chalef, 09 Dec 2025, updated 03 Jun 2026): 50 runs sweeping retrieval limits on LoCoMo
with gpt-4o-mini as both agent and judge, 10 users × 35 sessions. 5 edges / 2 nodes → **69.62%**
at 347 context tokens; 20/20 → **80.06%** at 1,378 tokens; 30/30 → **80.32%** at 1,997 tokens.
Retrieval p50 ranged 149–241 ms. The design principle stated there is the one worth stealing:
"Modern LLMs are good at filtering irrelevant context in their input. They're much less good at
inferring facts that aren't there." Returns flatten past 20/20.

### The Mem0 LoCoMo dispute — both sides, from their own publications

I present both sides and do not adjudicate. See B5 for Mem0's architecture.

**Mem0's original claim, from Mem0's own paper.**
["Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory"](https://arxiv.org/abs/2504.19413),
Prateek Chhikara, Dev Khant, Saket Aryan, Taranjeet Singh, Deshraj Yadav, v1 only, 28 Apr 2025.
Abstract, verbatim: "Mem0 achieves 26% relative improvements in the LLM-as-a-Judge metric over
OpenAI, while Mem0 with graph memory achieves around 2% higher overall score than the base Mem0
configuration" and "Mem0 attains a 91% lower p95 latency and saves more than 90% token cost".

**Zep was a baseline in that paper, and it lost.** Table 2, LoCoMo, overall J score with p95
search latency and memory tokens:

| Method | Memory tokens | Search p95 | Overall J |
|---|---|---|---|
| Full-context | 26,031 | – | **72.90 ± 0.19%** |
| RAG k=2 (best) | 256 | 0.699 s | 60.97 ± 0.20% |
| A-Mem | 2,520 | 1.485 s | 48.38 ± 0.15% |
| LangMem | 127 | 59.82 s | 58.10 ± 0.21% |
| **Zep** | 3,911 | 0.778 s | **65.99 ± 0.16%** |
| OpenAI (ChatGPT memory) | 4,437 | – | 52.90 ± 0.14% |
| **Mem0** | 1,764 | **0.200 s** | **66.88 ± 0.15%** |
| **Mem0 + graph** | 3,616 | 0.657 s | **68.44 ± 0.17%** |

Mem0 says it evaluated Zep's hosted platform, "maintaining temporal fidelity by preserving
timestamp information alongside conversational content", over "10 independent runs for each
method", excluding LoCoMo Category 5 "because ground truth answers were unavailable". Note that
**a plain full-context baseline beat every memory system in Mem0's own table** — Zep uses that
fact in its rebuttal. Mem0 also concedes one category loss: "In open-domain settings, the
baseline Zep achieves the highest F1 (49.56) and J (76.60) scores." And it accuses Zep on
storage cost: "Zep's memory graph consumes in excess of 600k tokens … Zep's design choice to
cache a full abstractive summary at every node while also storing facts on the connecting edges,
leading to extensive redundancy", plus ingest lag: "re-running identical searches after a delay
of several hours yielded considerably better results."

**Zep's rebuttal.** ["Lies, Damn Lies, & Statistics: Is Mem0 Really SOTA in Agent Memory?"](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/),
Daniel Chalef and Preston Rasmussen, 06 May 2025, updated 03 Jun 2026. Zep alleges Mem0's paper
misconfigured Zep in three ways — user modelling, timestamp handling, and "Sequential vs.
Parallel Searches" — and criticises LoCoMo itself: conversations "average around 16,000-26,000
tokens", the benchmark "lacks questions designed to test knowledge updates", "Category 5 was
unusable due to missing ground truth answers", plus "Incorrect Speaker Attribution" and
"Underspecified Questions". Zep reports "p95 search latency of 0.632 seconds" for Zep versus
Mem0 0.778 s and Mem0 Graph 0.657 s.

**Zep published a correction to its own number.** Verbatim from the live page:

> "📍 Correction: In an earlier version of this article, we erred in how we calculated Zep's
> LoCoMo score. We've updated the article to reflect Zep's corrected result is **75.14% +/-
> 0.17**, with Zep outperforming Mem0 by 10%."

and

> "This starkly contrasts with the **65.99% score reported for Zep in the Mem0 paper**, likely a
> direct consequence of the implementation errors discussed below."

**Mem0's counter-rebuttal**, filed as an issue in Zep's own repository:
["Revisiting Zep's 84% LoCoMo Claim: Corrected Evaluation & 58.44% Accuracy"](https://github.com/getzep/zep-papers/issues/5),
by **deshraj** (Mem0 co-founder/CTO), 2025-05-08, now closed. Mem0 alleges Zep counted
adversarial-category questions in the numerator but not the denominator, inflating the score by
about 25.56 points (58.44 + 25.56 = 84.00), used a modified system prompt, and ran the
evaluation once rather than ten times.

**Zep conceded the arithmetic and rejected the rest.** Daniel Chalef, 2025-05-12, in that thread:

> "@deshraj Thanks for pointing out the error in our calculation of Zep's LoCoMo score. The
> corrected score is 75.14% +/- 0.17 (over 10 runs), with Zep outperforming Mem0 by ~10%. …
> **We stand by our critique of your methodology, experimental setup of Zep, and your selection
> of the flawed LoCoMo evaluation.**"
> "We performed 10 independent runs for Zep, not just one as you suggested."
> "We're struggling to see how you got to a revised 58.44%."

The issue was closed 2025-05-19 "Closing due to inactivity."

**Documented methodological differences.** These are the concrete, artefact-level differences
between the two harnesses. I do not adjudicate them.

| Dimension | Mem0's run of Zep | Zep's own run |
|---|---|---|
| Ingest call | `memory.add(session_id=..., Message(role=speaker, role_type="user", content=f"{timestamp}: {text}"))` — both speakers as `role_type="user"`, timestamp inside the message text | `graph.add(data=..., type='message', created_at=iso_date, group_id=...)` — timestamp in the dedicated `created_at` field |
| Image captions | not ingested | ingested as `(description of attached image: ...)` |
| Scope key | `user_id` | `group_id` |
| Search concurrency | two **sequential** calls | `await asyncio.gather(...)`, two **parallel** calls |
| Answer prompt | `ANSWER_PROMPT_ZEP` | a custom prompt adding a rule on event time versus mention time |
| Runs | "10 independent runs for each method" | Zep claims 10 runs; Mem0 says one; the script on `main` is a single pass |
| Full-context baseline | present (26,031 tokens, J = 72.90) | absent from the LoCoMo scripts |
| Latency vantage | not stated | "measured from AWS us-west-2 with transit through a NAT setup" |

Sources: [mem0ai/mem0 `evaluation/`](https://github.com/mem0ai/mem0) and
[getzep/zep-papers `kg_architecture_agent_memory/locomo_eval`](https://github.com/getzep/zep-papers/blob/main/kg_architecture_agent_memory/locomo_eval/README.md)
(which reports Overall 75.14%, Single-Hop 79.79%, Multi-Hop 74.11%, Open Domain 66.04%,
Temporal 67.71%).

**The benchmark itself is weak, on its authors' own account.** LoCoMo comes from
[snap-research/locomo](https://github.com/snap-research/locomo) and
[arXiv:2402.17753](https://arxiv.org/abs/2402.17753) (Maharana, Lee, Tulyakov, Bansal, Barbieri,
Fang; ACL 2024). Its limitations section says, verbatim: "Our dataset is sourced primarily from
text generated by LLMs… we acknowledge that this dataset may not fully reflect the nuances of
real-world online conversations"; "we find that the images in our dataset can be replaced with
their captions without much loss of information"; and "LLMs are prone to generating verbose
answers even when prompted to answer in short phrases. This creates challenges in evaluating the
correctness of answers… Our evaluation framework suffers from the same challenges." The repo has
had no push since 2024-08-13, and there are open, unanswered label-error reports on it
(issues [#27](https://github.com/snap-research/locomo/issues/27),
[#35](https://github.com/snap-research/locomo/issues/35),
[#42](https://github.com/snap-research/locomo/issues/42)). An independent audit repo,
[dial481/locomo-audit](https://github.com/dial481/locomo-audit), reports "Ground truth errors |
99 of 1,540 questions (6.4%) have wrong golden answers. Theoretical scoring ceiling is 93.57%."
and "62.81% of intentionally wrong vague-but-topical answers accepted by the LLM judge." A
follow-up paper cites it ([arXiv:2607.21962](https://arxiv.org/abs/2607.21962)). **Zep's current
published LoCoMo score of 94.7% is above that audited 93.57% ceiling**, which by itself should
stop anyone quoting it as a capability measure.

**The state of the record, and why I would not cite a bare LoCoMo number.** Zep has published
four different LoCoMo figures for its own system inside about a year: 84% (withdrawn) → 75.14%
±0.17 (blog, 2025) → 80.32% (retrieval-tradeoff post, Dec 2025) → 94.7% (research page,
current). Mem0's paper reports Zep at 65.99%; Mem0's re-run reports 58.44%. Mem0's own headline
moved from 66.88 (paper) to a claimed 92.5, and Mem0's raw results show the same run scoring
**91.6% at top-200 but 82.7% at top-50**
([mem0ai/memory-benchmarks](https://github.com/mem0ai/memory-benchmarks)). Mem0's docs say the
quiet part out loud: "Some benchmarks today, particularly smaller ones like LoCoMo and
LongMemEval, can be materially improved by aggressive retrieval strategies, larger context
windows, or frontier models. That does not necessarily mean the underlying memory system has
gotten better." ([Mem0 memory evaluation docs](https://docs.mem0.ai/core-concepts/memory-evaluation)).
Zep agrees about the benchmark: "we're not huge fans of this benchmark. It has known issues with
question quality and answer ambiguity."
([The Retrieval Tradeoff](https://blog.getzep.com/the-retrieval-tradeoff-what-50-experiments-taught-us-about-context-engineering/)).

**Conclusion: no published benchmark number should influence our decision.** The 2025 dispute
used gpt-4o-mini on both sides; the 2026 claims use gpt-5-class readers and judges at different
retrieval depths, so any cross-vendor table compares reader models as much as memory systems.
Both parties are vendors evaluating themselves with LLM judges, neither published a reconciled
number, and the dataset's own authors and an independent audit both say it is unreliable. Note
also that a *third* vendor, Supermemory, claims "#1 on LongMemEval, LoCoMo, and ConvoMem" in its
README while its [research page](https://supermemory.ai/research) supports only a Recall@k
retrieval metric (86% @5, 91% @10, 95% @15) with no competitor and no J score — a different
metric entirely. The only useful measurement is our own traffic.

## A8. Zep Cloud pricing and limits

Fetched from [getzep.com/pricing](https://www.getzep.com/pricing) on **2026-08-20**. Prices
change; re-check before any decision.

Pricing is **credit-based on ingestion only**. Verbatim:

> "**1 credit** per Episode up to 350 bytes; +1 credit per additional 350 bytes (or part)."
> "**⅛ credit** per webhook invocation, where available."
> "**0 credits** for retrieval, storage, threads, users, and graph storage."
> "An Episode is any single data object you send to Zep — a chat message, JSON payload, or block of text."
> "A 640-byte Episode uses 2 credits; a 1,200-byte Episode uses 4 credits."
> "You are charged for ingestion and processing of Episodes. You are not charged for storage of messages or data."

| | Free | Flex | Flex Plus | Enterprise |
|---|---|---|---|---|
| Price | $0 | **$1,250 / year** ("$104 / month, billed annually") or **$125 / month** | **$3,750 / year** ("$312 / month, billed annually") or **$375 / month** | "Custom" — contact sales |
| Included credits / month | 10,000 | 50,000 | 200,000 | "Custom credits with negotiated rates" |
| Overage | none | "$25 / 10,000 credits" | "$75 / 40,000 credits" | "Negotiated" |
| Auto top-up at 20% | "No rollover or auto-topup" | "10k credits ($25)" | "40k credits ($75)" | Custom |
| Credit rollover | none | 30 days | 60 days | Custom |
| **Requests per minute** | "Variable rate limits, depending on service-wide load" | **600** | **1,000** | "Guaranteed, custom" |
| Projects | 2 | 5 | 10 | Unlimited |
| Memory MCP seats | 1 | 5 | 15 | Custom |
| Custom entity & edge types | 5 | 10 | 20 | not stated |
| Observations | — | not included | included | included |
| Webhooks / Analytics / Custom extraction instructions | — | — | included | included |
| API log retention | — | 1 day | 7 days | 1 year |
| Audit logs / SOC 2 Type II / HIPAA BAA | — | — | — | included |
| Support | Community | Community | Priority | "Slack/Teams · dedicated AM" |
| Deployment | Cloud | Cloud | Cloud | "Cloud · Cloud + BYOK · BYOC" |

The annual saving is stated as "Save 17%", consistent with $1,250 versus $1,500. The Free tier
notes "Lower priority Episode processing." and the page carries the caveat "Feature availability
and service levels may change over time."

Rate limits are "measured in requests per minute (RPM) and applied per account", with headers
`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`,
`X-RateLimit-Increment` ("Always `1`") and `Retry-After` on 429
([Rate limits](https://help.getzep.com/rate-limits)). The pricing FAQ adds: "Free and Flex Plan
customers may see rate limits lowered depending on service usage."

**What this means for build-versus-buy.** Two things.

First, **the 350-byte bucket is small.** A typical chat turn of 700 bytes already costs 2
credits. Rough model: at Flex Plus, 200,000 included credits per month at an average of 2 credits
per message is about **100,000 messages per month** for $312/month. Overage past that is
$75 / 40,000 credits, or about $0.00375 per message-ish episode. That is *cheaper than the raw
LLM cost of doing the same extraction ourselves* on the call counts in A3 — Graphiti's pipeline
alone is several LLM calls per episode. **Zep Cloud is not the expensive option; building it is.**

Second, **retrieval is free**, so read-heavy agents are cheap on Zep and the cost driver is
purely ingest volume. That is the opposite shape from a self-built system, where every retrieval
costs embedding calls and database work.

**Enterprise pricing is unpublished** — the page says only "Custom credits with negotiated
rates" and "Guaranteed rate limits with SLA". Do not model it.

## A9. Licensing

**Graphiti is Apache License 2.0.** The repository
[`LICENSE`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/LICENSE)
is the standard 201-line Apache-2.0 text, and
[`pyproject.toml`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/pyproject.toml)
declares `license = "Apache-2.0"`. Every source file carries the Apache-2.0 header with
`Copyright 2024, Zep Software, Inc.`

**Restrictions I found in the repository: none beyond Apache-2.0 itself.** No BSL, no
commercial-use clause, no field-of-use restriction. Practically that means: we may use,
modify, self-host and ship Graphiti in a commercial product, we must preserve the license and
notices, and we get the Apache-2.0 patent grant. The only obligation is attribution.

**Contributing** requires a CLA. [`Zep-CLA.md`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/Zep-CLA.md)
grants Zep Software, Inc. "a perpetual, worldwide, non-exclusive, no-charge, royalty-free,
irrevocable copyright license to reproduce, prepare derivative works of, publicly display,
publicly perform, sublicense, and distribute Your Contributions". This matters only if we
upstream patches.

**The TypeScript client is also Apache-2.0.** `@getzep/zep-cloud@3.10.0` ships a full
Apache-2.0 `LICENSE`. It is a client only; it grants no rights to the server.

**Zep Cloud itself is proprietary.** The Context Graph Engine is described as "a proprietary
graph database" in the Graphiti README, and the Zep-vs-Graphiti docs page adds "proprietary
extraction LLMs, reranker, and embedding models"
([help.getzep.com/zep-vs-graphiti](https://help.getzep.com/zep-vs-graphiti)). Self-hosting Zep
is an Enterprise commercial arrangement ("Cloud + BYOK · BYOC",
[pricing](https://www.getzep.com/pricing)), not an open license, and the old self-hostable
community edition is "deprecated and no longer supported"
([FAQ](https://help.getzep.com/faq)).

---

# Part B — Could we ship a decent version ourselves?

## B0. What `-dimension-ai-web` has (the repo Part B is costed against)

Part B was costed against the sibling repo `-dimension-ai-web`, because that is
the repo that already carries the Zep dependency. Paths in this section are
relative to `-dimension-ai-web`, not to Alfred. Alfred's own position is in
section 0b; the contrast table follows this one.

| Concern | What we use | Evidence |
|---|---|---|
| Monorepo | pnpm 9 + turbo 2.5, TypeScript 5.8, Node ≥18 | `package.json` |
| Apps | `apps/web`, `apps/api`, `apps/consumers`, `apps/ai-export` | `apps/` |
| Packages | `services`, `models`, `jobs`, `events`, `backend-lib`, `trpc`, `publishers`, `shared-types`, and others | `packages/` |
| Database | **Postgres via Drizzle ORM** (`drizzle-orm@^0.41.0`, `drizzle-kit@^0.31.4`, `pg`, `postgres`) — not Prisma, not Mongo | `packages/models/package.json` |
| Sync layer | Replicache (`replicache@^15.3.0`) | `packages/models/package.json` |
| Queue / events | **NATS JetStream** (`nats@^2.24.0`) with a publisher/consumer abstraction | `packages/events/{eventbus.ts,streaming/}`, `apps/consumers/src/register-consumers.ts` |
| Vector search | **Turbopuffer** (`@turbopuffer/turbopuffer`), one namespace per integration | `packages/backend-lib/turbopuffer/` (13 `*-ns.ts` files) |
| Embeddings | **Voyage `voyage-3.5`, 1024 dims**, via `@langchain/community` | `packages/backend-lib/embeddings/index.ts`, class `EmbeddingService` |
| Hybrid search | Already implemented: ANN + BM25 in one Turbopuffer multi-query, fused with RRF | `packages/backend-lib/turbopuffer/artifacts-ns.ts` (`rank_by: ["vector","ANN",…]` and `["content","BM25",…]`), `packages/backend-lib/turbopuffer/helpers.ts` (`reciprocalRankFusionForIntegrationResults`) |
| Memory today | **Zep Cloud, already a dependency** — `@getzep/zep-cloud@^3.10.0` | `packages/trpc/package.json` |
| Zep usage today | `zepClient.user.add(...)` on signup, and a `MANAGE_ZEP_STATE` NATS event with variants `create_user \| delete_user \| create_thread \| delete_thread` | `packages/trpc/server/routers/auth.router.ts`, `packages/events/events/memory/manage-state.event.ts`, `packages/trpc/server/mutators/threads.mutator.ts`, `packages/jobs/delete-account.consumer.ts` |
| Direct LLM SDK | **None.** No `openai`, `@anthropic-ai/sdk`, `ai`, or `@ai-sdk/*` in any `package.json`. Only `@langchain/core`, `@langchain/community`, `@langchain/langgraph-sdk` in `packages/backend-lib` | repo-wide grep of `package.json` files |
| Where inference lives | `@langchain/langgraph-sdk` is declared but I found **no TypeScript import of it**; the only `@langchain/*` imports in source are the Voyage embedder and one Turbopuffer namespace. Agent inference appears to live in a separate LangGraph service outside `-dimension-ai-web`. | `packages/backend-lib/package.json`, grep of `@langchain/` imports |
| No pgvector | No `vector(...)` column or pgvector custom type in the Drizzle schemas | `packages/models/drizzle/schemas/` |

### The same table for Alfred

Alfred differs on every row that matters to this question, which is why Part B's
conclusion does not transfer.

| Concern | `-dimension-ai-web` | Alfred |
|---|---|---|
| Database | Postgres + Drizzle | Postgres + Drizzle (`packages/db`) |
| Vector store | Turbopuffer, 13 namespaces | **pgvector in Postgres**, `vector(1024)`, HNSW over `halfvec` (`packages/db/src/schema/memory.ts:346`, `migrations/0023_halfvec_embedding_indexes.sql`) |
| Queue | NATS JetStream | **BullMQ on Redis**, workers in-process in `apps/server` |
| LLM SDK | **none** | **Vercel AI SDK v7**, centralised model routes in `packages/ai/src/provider.ts` |
| Embeddings | Voyage `voyage-3.5` via `@langchain/community` | Voyage `voyage-3.5`, metered, `packages/ai/src/embeddings.ts` |
| Bi-temporal facts | none | **`user_facts`** with `valid_from` / `valid_until` / `supersedes_id` / status chain |
| Graph model | none | **`entities` + `entity_relations`**, typed edges |
| Event log | none | **append-only `observations`** + replayable projections (`packages/db/src/schema/user-model.ts`) |
| Memory intelligence | none | ~35 modules in `packages/assistant/src/knowledge/` |
| Zep dependency | `@getzep/zep-cloud@^3.10.0`, four calls | none, and rejected by ADR-0058 |
| Tenancy | multi-user | single user (ADR-0001) |

The practical consequence: for `-dimension-ai-web` the cheapest win is to use the
Zep subscription it already pays for. For Alfred the cheapest win is to finish
the projections it has already designed. Neither repo should build a graph
engine.

Two conclusions follow immediately.

1. **We already pay for Zep and barely use it.** We create users and threads but I found no
   call to `thread.addMessages` or `thread.getUserContext` anywhere in the TypeScript. Whatever
   memory quality problem prompted this research, the first experiment is to actually send
   messages and read the context block back.
2. **If we build, we should build on Turbopuffer, not on pgvector.** We have no pgvector and
   a mature Turbopuffer layer with hybrid search and RRF already written. Introducing pgvector
   would add a capability we already have. This changes the "reduced-scope v1" design in B3
   relative to the brief's premise.
3. **A third, structural point:** `-dimension-ai-web` has no LLM inference at all. If we build a
   memory extraction pipeline, it either introduces the first LLM SDK here, or it belongs in the
   LangGraph service where inference already lives. That is an architecture decision to settle
   before estimating, and it is a reason to prefer a service boundary (Zep, or a wrapped
   Graphiti) over in-monorepo extraction.

## B1. What is genuinely reusable off the shelf

**Reusable as-is:**

- `graphiti-core` on PyPI, Apache-2.0. The whole pipeline, prompts and search recipes.
- **The FastAPI HTTP wrapper exists**: `server/` in the repo is `graph-service`, "a fast api
  server implementing the graphiti package", published as the Docker image `zepai/graphiti`
  with `latest` and version tags, built for `linux/amd64` and `linux/arm64`
  ([`server/README.md`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/server/README.md)).
  Its endpoints are `POST /messages`, `POST /entity-node`, `POST /search`,
  `POST /get-memory`, `GET /entity-edge/{uuid}`, `GET /episodes/{group_id}`,
  `DELETE /entity-edge/{uuid}`, `DELETE /group/{group_id}`, `DELETE /episode/{uuid}`,
  `POST /clear`
  ([`server/graph_service/routers/ingest.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/server/graph_service/routers/ingest.py),
  [`retrieve.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/server/graph_service/routers/retrieve.py)).
- **An MCP server exists**: `mcp_server/`, described in its own README as "an experimental
  Model Context Protocol (MCP) server implementation", default FalkorDB, HTTP transport at
  `/mcp/`, 13 tools
  ([`mcp_server/README.md`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/mcp_server/README.md)).
- The prompt set, which is the most valuable artefact if we build our own. The prompts encode
  a lot of hard-won behaviour: the "NEVER generalize 'Gamecube' to 'gaming console'" rule, the
  duplicate-versus-more-specific distinction, the continuous-index trick for two candidate
  lists. We can port these to TypeScript under Apache-2.0 with attribution.
- The algorithms are small and portable: `rrf` (~15 lines), `maximal_marginal_relevance`
  (~35 lines), `label_propagation` (~45 lines), the MinHash/LSH dedup helpers (~300 lines
  including comments).

**Is Python a problem for us?** Moderately. We have no Python service today; every app is
Node (`apps/ai-export` is Fastify + Playwright, `apps/consumers` is NATS + TypeScript). Adding
`zepai/graphiti` means a new runtime, a new Dockerfile in `infra/`, new secret plumbing
through Infisical, and a Neo4j or FalkorDB cluster. It is not a language-interop problem —
the boundary is HTTP — it is an operational-surface problem.

**Two honest caveats about the reference server.**

1. **It is not production-grade queueing.** `server/graph_service/routers/ingest.py` defines
   `class AsyncWorker` holding a single `asyncio.Queue` and starting exactly **one** worker
   task in `lifespan`. `POST /messages` enqueues and returns `202`. On shutdown, `stop()`
   cancels the task and then drains the queue with `get_nowait()` — **queued episodes are
   discarded**. There is no persistence, no retry, no dead-letter, no visibility. The MCP
   server is slightly better: `QueueService` in
   [`mcp_server/src/services/queue_service.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/mcp_server/src/services/queue_service.py)
   keeps one `asyncio.Queue` and one worker **per `group_id`** ("Service for managing
   sequential episode processing queues by group_id"), so different users progress in
   parallel — but it is still in-memory and lost on restart. If we wrap Graphiti, we keep our
   NATS JetStream queue in front and call the library or the container one episode at a time
   per user.
2. **`/get-memory` is thinner than Zep Cloud's context block.** It concatenates the request
   messages into one query string (`compose_query_from_messages`), runs one search, and returns
   a flat `facts: FactResult[]`. It does **not** call
   `search_results_to_context_string`, and it ignores the `center_node_uuid` field its own DTO
   declares (`server/graph_service/dto/retrieve.py`). We would write the context assembly
   ourselves.

## B2. The hard parts, honestly

**Entity resolution at scale.** This is the crux, and Graphiti's answer is good but bounded.
The deterministic pass is cheap and correct for exact and near-exact names. The escalation
path costs one LLM call and, more importantly, depends on candidate recall from
`node_similarity_search` with `limit=15` and `min_score=0.6`. Two failure modes are structural:
(a) an entity whose name is phrased differently enough to fall outside the top 15 by *name*
embedding similarity silently becomes a new node — the graph fragments; (b) the entropy gate
sends every short or low-entropy name ("Sam", "SF", "the deck") to the LLM, so cost rises
exactly where precision is hardest. There is no periodic offline merge pass in the OSS code.
Fragmentation is not self-healing.

**LLM cost and latency per episode.** From A3: 3 to 5 calls for a trivial message, 18 to 33
for a dense one, plus 2 hybrid searches and 2 query embeddings per extracted edge. These are
sequential in stages (extract nodes → resolve → extract edges → resolve edges), so tail
latency is the sum of four LLM round trips minimum, not the max. Zep's OSS defaults are
`gpt-5.5` for the main calls and `gpt-4.1-nano` for the small ones, which tells you they
already pushed everything they could to a cheap model. Any TypeScript reimplementation faces
the same arithmetic. Budget this per episode, not per conversation.

**Write throughput and concurrency.** Graphiti's own docstring says episodes must be added
"sequentially and awaited before adding the next one". Both reference servers enforce that with
in-memory queues (single global worker in `server/`, per-`group_id` worker in `mcp_server/`).
The reason is correctness: two concurrent episodes for the same user can each resolve the same
new entity against a graph that does not yet contain the other's writes, producing duplicates.
`resolve_extracted_edges` even has an `existing_edges_override` parameter whose comment
mentions "the recent Redis dedup cache" — evidence that Zep's own production system needs an
out-of-band cache to paper over this. **Practical consequence: per-user write throughput is
capped at roughly 1 / (episode latency).** If an episode takes 4 seconds, one user can absorb
15 messages a minute. Bursty chat will queue.

**Graph DB operational burden.** Neo4j or FalkorDB is a new stateful system: backups,
upgrades, memory tuning, failover, and a Cypher-shaped mental model nobody on the team has.
Compounding it: **no vector index** (A6), so query cost grows with per-tenant graph size, and
**no uniqueness constraints**, so bugs produce duplicate `uuid` rows silently. Neptune needs
OpenSearch Serverless alongside it. Kuzu is deprecated. FalkorDB is the lightest option and
the MCP server's default.

**Prompt quality.** The prompts are the product. `extract_edges.py`'s rule 5 ("NEVER
generalize 'Gamecube' to 'gaming console' … every concrete noun, number, and descriptor in the
source should survive into the `fact`") and rule 4 (the duplicate-versus-more-specific
distinction) are the kind of thing you only learn from thousands of failures. Writing these
from scratch is where a naive rebuild loses six weeks. Porting them is legal and fast.

**Eval methodology.** The OSS repo has an eval harness but it is thin:
`tests/evals/eval_cli.py` takes `--multi-session-count` and `--session-length`, builds a graph
and calls `eval_graph`; `tests/evals/data/` holds only `longmemeval_data`; and the judging is
itself LLM-based (`prompts/eval.py` defines `qa_prompt`, `eval_prompt`,
`eval_add_episode_results`, `query_expansion`). There is no golden dataset of *our* domain and
no regression gate. We would have to build our own eval set — realistically 100 to 300
hand-labelled multi-session cases — before we could tell whether a change helped. **This is
the single most under-estimated line item in any build plan.**

**Temporal correctness.** Invalidation needs both edges dated and strictly ordered (A4).
Undated facts never invalidate. `resolve_edge_contradictions` also writes
`edge.invalid_at = resolved_edge.valid_at`, which asserts the old fact ended exactly when the
new one began — reasonable for state changes ("moved from Berlin to Lisbon"), wrong for
overlapping facts. And the context block shows invalidated facts with their dates rather than
filtering them, so final correctness depends on the *consuming* LLM reading dates properly.

**Multi-tenancy and data isolation.** Logical only, via `group_id`, with the
`driver.clone(database=group_id)` mutation hazard noted in A6. Any leak is a
cross-customer-memory leak, which is the worst class of bug this feature can have. If we build
our own on Turbopuffer + Postgres we get tenant scoping from the same primitives we already
use everywhere else — a genuine argument for building rather than wrapping.

## B3. A realistic reduced-scope v1

The brief suggests Postgres + pgvector. **I would use Postgres (Drizzle) + Turbopuffer
instead**, because `-dimension-ai-web` has no pgvector and already has a working Turbopuffer hybrid-search
layer with RRF (`packages/backend-lib/turbopuffer/`) and a Voyage embedder
(`packages/backend-lib/embeddings/index.ts`). Same shape, less new infrastructure.

### Data model — three Drizzle tables, no graph

```
memory_episode
  id, user_id, thread_id, source ('message'|'text'|'json'), content,
  source_description, valid_at (event time), created_at (system time)

memory_entity
  id, user_id, name, normalized_name, entity_type, summary,
  created_at, updated_at
  unique (user_id, normalized_name)

memory_fact
  id, user_id, subject_entity_id, object_entity_id, relation_type, fact_text,
  valid_at, invalid_at,        -- event time
  created_at, expired_at,      -- system time
  episode_ids jsonb            -- provenance
  index (user_id, expired_at), index (user_id, subject_entity_id)
```

Keep the bi-temporal quartet exactly as Graphiti defines it — it costs nothing and it is the
part that actually earns its keep. Mirror `memory_fact` rows into a Turbopuffer namespace
(`fact_text` embedding + BM25 on `fact_text`), one namespace per user. **We already do exactly
this**: `packages/backend-lib/turbopuffer/artifacts-ns.ts` resolves
a namespace named ``${userId}_artifacts`` via `tpuf.namespace(...)`, and `ns-cache.ts` caches
the per-user namespace map in Redis with a 60-second TTL. A ``${userId}_memory`` namespace slots
straight into that pattern, and
physical per-user isolation is a real advantage over Graphiti's logical `group_id` filtering.

Small but worth noting: our `RRF_K` is `60`
(`packages/backend-lib/turbopuffer/constants.ts`) whereas Graphiti's `rrf` uses
`rank_const=1` (`search_utils.py`). `k=60` is the value from the original RRF paper and
flattens the score curve; `k=1` weights the top rank far more heavily. If we port Graphiti's
retrieval behaviour we should be deliberate about which constant we want, and measure it.

### Pipeline — 2 LLM calls per episode, not 15

1. **One combined extraction call.** Entities and facts with dates in a single structured
   output, following Graphiti's own `combined_extraction.py` design and porting the prompt
   text from `extract_nodes.py` and `extract_edges.py`. One call.
2. **Deterministic entity resolution.** Port `_normalize_string_exact`,
   `_has_high_entropy`, MinHash/LSH and the Jaccard threshold from `dedup_helpers.py`
   verbatim; add a Turbopuffer ANN lookup on entity names for candidates. Resolve
   deterministically; when ambiguous, **prefer creating a new entity over a wrong merge** and
   record it for a nightly merge job. Zero LLM calls in the hot path.
3. **One resolution call for facts.** Retrieve candidate facts for the same entity pair from
   Postgres plus a Turbopuffer hybrid search, and issue **one batched** call covering all new
   facts at once (Graphiti does one call per edge — batching is the obvious saving), returning
   duplicate and contradiction indices in Graphiti's `EdgeDuplicate` shape.
4. **Deterministic invalidation.** Port `resolve_edge_contradictions` exactly. It is 30 lines
   of date arithmetic and it is the correctness core.
5. **No node summaries, no communities, no attributes** in v1.
6. **Retrieval.** Reuse the existing Turbopuffer pattern: ANN over `fact_text` + BM25 in one
   multi-query, fuse with the existing `reciprocalRankFusionForIntegrationResults`, then
   assemble a context block in Graphiti's format (facts with `valid_at` / `invalid_at`,
   `"Present"` for null, plus entity summaries).

Run the whole thing as a NATS JetStream consumer in `apps/consumers` with a per-user
serialization key, so we inherit retries, durability and observability from infrastructure we
already run.

### What we lose by dropping the graph

- **Multi-hop traversal / BFS search.** No `bfs_origin_node_uuids`, so no "what else connects
  to this" retrieval. Mitigation: a recursive CTE or a two-step SQL join gets you depth 2
  adequately. Depth 3+ is where SQL stops being pleasant.
- **`node_distance` reranking.** Needs adjacency. Approximate it with "facts sharing an entity
  with the current focus entity".
- **Communities.** No cluster-level summaries, so no "what is this user broadly about"
  rollups. Mitigation: a periodic per-user summary from top facts by episode count — cruder,
  much cheaper.
- **Entity summaries that evolve.** Droppable in v1; note that Graphiti's `EntityNode.summary`
  is what makes the `<ENTITIES>` half of the context block useful.
- **Sagas / episode chains.** Trivial to add later as a `prev_episode_id` column.
- **`episode_mentions` reranking** is actually *easier* in SQL: `jsonb_array_length(episode_ids)`.

What we keep: bi-temporal facts, contradiction handling, provenance, hybrid retrieval, and the
context block format. In my judgement that is 80% of the observable value for a chat-memory
product, at roughly one seventh of the LLM cost.

## B4. Effort estimate

Assumptions: one strong backend engineer who knows `-dimension-ai-web`; estimates include tests and
a basic eval set; they exclude a formal eval programme (add 3 to 4 weeks for that separately)
and exclude any UI.

### (a) Wrap Graphiti as a service — **3 to 5 engineer-weeks**

| Work | Weeks |
|---|---|
| Deploy `zepai/graphiti` + FalkorDB in `infra/`, secrets via Infisical, health checks | 1.0 |
| Typed TS client in `packages/backend-lib` or `packages/services`, plus a NATS consumer with per-user serialization | 0.8 |
| Context assembly (the reference `/get-memory` is too thin — port `search_results_to_context_string`) | 0.4 |
| Tenant scoping on `group_id`, deletion/GDPR paths, `GRAPHITI_TELEMETRY_ENABLED=false` | 0.6 |
| Observability, cost metering, backpressure, load test | 0.8 |
| Buffer | 0.5 |

Risks: a second language runtime forever; a graph DB to operate; the no-vector-index scaling
wall; and you are now pinned to Graphiti's release cadence. Cheapest path to the full feature
set, most expensive path operationally.

### (b) Build from scratch in TypeScript (the B3 design) — **8 to 13 engineer-weeks**

| Work | Weeks |
|---|---|
| Drizzle schema + migrations for the three tables | 0.6 |
| Combined extraction: prompt port, structured-output plumbing (we have **no** direct LLM SDK today — add one), validation, retries | 1.5 |
| Entity resolution: port `dedup_helpers.py` to TS, Turbopuffer name index, nightly merge job | 2.0 |
| Fact resolution + batched contradiction call | 1.5 |
| Invalidation arithmetic (port `resolve_edge_contradictions`) + property tests | 0.8 |
| Retrieval: Turbopuffer namespace, hybrid + RRF (mostly reuse), context block assembly | 1.2 |
| NATS consumer, per-user serialization, idempotency, dead-letter | 1.0 |
| Eval set: 100 to 300 labelled multi-session cases + a harness | 2.0 |
| Observability, cost metering, tenant deletion | 0.8 |
| Buffer | 1.5 |

Risks: the eval line item is the one that slips. Without it you cannot tell a regression from
noise, and memory bugs are silent. Also note we would be introducing our first direct LLM SDK
dependency — a decision with its own blast radius.

### (c) Simpler flat-memory approach — **1.5 to 3 engineer-weeks**

Scope: a `user_fact` table (`user_id`, `fact_text`, `created_at`, `source_message_id`,
`superseded_by`), one LLM call per N turns that emits "durable facts about this user", write
them, embed into Turbopuffer, retrieve top-k by hybrid search, render as a bullet list in the
system prompt. Supersession by "newest wins for the same topic", not by temporal reasoning.

| Work | Weeks |
|---|---|
| Schema, extraction prompt, consumer | 0.8 |
| Turbopuffer namespace + retrieval + prompt block (heavy reuse) | 0.5 |
| Dedup by embedding threshold, supersede-on-conflict | 0.5 |
| Smoke evals, metering | 0.4 |

**Shortcut worth considering:** Mem0's TypeScript OSS engine (`mem0ai/oss`, npm `mem0ai` 3.1.6,
Apache-2.0) already implements exactly this design — one LLM extraction call, hybrid vector plus
BM25 retrieval, entity boosts — and ships a **Turbopuffer adapter**, which is the vector store we
already run. Using it would collapse this option to roughly **1 engineer-week of integration**.
Accept that it is ADD-only with no temporal model (see B5); we could layer Graphiti's
`resolve_edge_contradictions` on top later.

This is the right first move if we have no evidence yet about *which* memory failures hurt us.
It is also a good baseline: if flat memory plus our existing Turbopuffer retrieval measurably
matches Zep on our own traffic, the graph question is settled and we stop.

### And option (d), which the brief did not ask for: use what we already pay for

**0.5 to 1 engineer-week.** Add `thread.addMessages` on message create and
`thread.getUserContext(threadId, { mode: "basic" })` on prompt assembly. The SDK, the client,
the user records and the thread records already exist in `-dimension-ai-web`. **Do this first,
regardless of which of (a)/(b)/(c) we later choose** — it is the only way to get real data
on whether the graph approach helps our product.

## B5. Alternatives

Summary table first, then one paragraph each. All read at the commits and versions named.

| | Language | License | Real OSS server? | Graph? | Bi-temporal? | Official TS SDK | Verdict for us |
|---|---|---|---|---|---|---|---|
| **Zep Cloud** | closed (Go/Python?) | proprietary | **No** (CE discontinued) | yes | yes | yes, `@getzep/zep-cloud` | Already integrated. Best turnkey option. |
| **Graphiti** | Python | Apache-2.0 | yes (FastAPI + MCP) | yes | **yes** | **no** | Best OSS engine, worst runtime fit. |
| **Mem0** | Python + TypeScript | Apache-2.0 | yes (FastAPI + pgvector) | **no — removed from OSS** | no | yes, and a full TS engine | Best TS story. No temporal model. |
| **Letta** | TypeScript (Bun) | Apache-2.0 | **archived** | no | no | yes | Different problem (agent-owned context). |
| **Cognee** | Python (+ Rust) | Apache-2.0 | yes (FastAPI + UI + Helm) | yes | partly, opt-in | weak (Rust bindings) | Closest OSS peer to Graphiti. |
| **Supermemory** | TS apps, closed engine | MIT apps, engine unlicensed | **no — binary only** | claimed | claimed | yes | Opaque. Rules itself out for us. |

### Mem0 — `github.com/mem0ai/mem0`

**Architecture.** A vector store plus a single-pass LLM extraction loop. `mem0/memory/main.py`
defines `class Memory(MemoryBase)`; `add()` calls `_add_to_vector_store()`, which the source
labels `# === V3 PHASED BATCH PIPELINE ===`. The phases: read the last 10 session messages, fetch
10 existing memories by vector search and map their UUIDs to integer indices (source comment:
`# Map UUIDs to integers (anti-hallucination)`), make **one** LLM call with
`ADDITIVE_EXTRACTION_PROMPT`, batch-embed, drop duplicates by MD5 of the text, batch-insert with
a `"event": "ADD"` history row, then extract entities with spaCy
(`mem0/utils/entity_extraction.py`) and link them. Search (`_search_vector_store()`) lemmatises
the query, over-fetches `max(limit*4, 60)` semantic hits, adds normalised BM25 keyword scores and
entity boosts, and fuses them in `score_and_rank(...)`. History is SQLite (`SQLiteManager`,
`~/.mem0/history.db`). **The famous ADD/UPDATE/DELETE/NOOP loop is dead code.**
`DEFAULT_UPDATE_MEMORY_PROMPT` and `get_update_memory_messages(...)` still exist in
`mem0/configs/prompts.py` but are referenced only from tests; the new prompt states "Your sole
operation is ADD", and the migration guide confirms: "**Extraction**: Single-pass ADD-only (one
LLM call, no UPDATE/DELETE)" and "`add()` events | Returns `ADD`, `UPDATE`, `DELETE` | Returns
`ADD` only" (`docs/migration/oss-v2-to-v3.mdx`). The only removal mechanism left is a hard
`expiration_date` payload key checked by `_payload_is_expired()`. **Graph memory has been removed
from the OSS build entirely**: the changelog (`docs/changelog/highlights.mdx`, 2026-04-14) says
"All external graph store backends (Neo4j, Memgraph, Kuzu, Apache AGE) were subsequently removed
in v2.0.0", and the migration table says "Graph memory is removed from OSS. It's a built-in,
always-on Mem0 Platform feature."
**License:** Apache-2.0, clean (`pyproject.toml` `license = "Apache-2.0"`, stock 201-line
`LICENSE`; `mem0-ts/package.json` also Apache-2.0). No BSL, no dual license.
**Self-host:** yes, genuinely. `server/` is a FastAPI app with Alembic migrations and an API-key
auth layer, `server/docker-compose.yaml` starts `mem0` on 8888, `pgvector/pgvector:pg17`, and a
Next.js dashboard on 3000; `make bootstrap` starts it. Library defaults are local Qdrant at
`/tmp/qdrant` and SQLite history. About 25 vector adapters ship — **including Turbopuffer and
pgvector**, both of which we already use.
**TypeScript:** the strongest of the Python-first projects. npm `mem0ai` 3.1.6, Apache-2.0, Node
≥18; the `mem0ai/oss` export is a **full local memory engine written in TypeScript** with 26
vector-store files, LLM providers, embedders and rerankers, not just a cloud client.
**Fit:** better than Zep when you want a cheap write path (one LLM call per turn), a broad choice
of vector stores including ones we run, and real TS parity. Worse when you need temporal
correctness: there is no graph, no relations beyond an entity boost score, no
`valid_at`/`invalid_at`, and no contradiction handling. Because it is ADD-only, memory grows
without bound unless we set `expiration_date` ourselves. **For us, `mem0ai/oss` on Turbopuffer is
the most credible off-the-shelf shortcut to the "flat memory" option (c) in B4** — it would
collapse that estimate to roughly 1 engineer-week of integration.

### Letta (formerly MemGPT) — `github.com/letta-ai/letta`

**The server is gone.** HEAD at `87fd37a` (2026-08-15) has the commit message "chore: archive the
legacy server repository (#3430)" and the whole tree is eight markdown files. The README says:
"The current source code lives in `letta-ai/letta-code`"; "The retired Letta V1 server source is
preserved on the `archive` branch"; "That source is unsupported, receives no fixes or security
updates, and should not be used in production."
**Architecture, V1 (archive branch, `letta` 0.16.8).** FastAPI + SQLAlchemy. Core memory is a set
of **blocks** — `letta/schemas/block.py` `class BaseBlock` with `value: str`, `limit: int`, and a
`label` "(e.g. 'human', 'persona')" — which the agent edits with the tools
`core_memory_append`, `core_memory_replace`, `memory_replace`. Archival memory is embedded
passages (`letta/orm/passage.py`) reached by `archival_memory_insert` /
`archival_memory_search`; recall memory is `conversation_search`.
`letta/schemas/memory.py` `class ContextWindowOverview` exposes the split. Sleep-time compute is a
multi-agent group (`letta/groups/sleeptime_multi_agent.py` … `_v4.py`, prompts
`letta/prompts/system_prompts/sleeptime_v2.py`).
**Architecture, current.** A TypeScript CLI harness where memory is **git-tracked files** (MemFS):
`src/agent/memory-git.ts`, `memory-filesystem.ts`, `memory-worktree.ts`, and the README's
"All context (including memory blocks) is tracked via git." Two backends exist
(`src/backend/backend-mode.ts`: `export type BackendMode = "api" | "local"`), and **the default is
`api`, i.e. Letta Cloud**; `local` writes append-only files under `~/.letta/lc-local-backend`.
**License:** Apache-2.0 in *both* repos. I checked specifically for a licence change and found
none — stock Apache text in each, `"license": "Apache-2.0"` in `letta-code/package.json`, and no
BSL/Elastic/Additional-Use-Grant language anywhere. What changed is not the code licence but the
addition of hosted-service terms (`TERMS.md`, liability capped at "$4.20", arbitration required),
which do not restrict the Apache grant.
**Self-host:** much weaker than before. V1 shipped `compose.yaml` with `ankane/pgvector` and
`letta/letta:latest`. The current docs say "The open source Docker image is no longer supported as
a backend for Letta Code" ([selfhosting](https://docs.letta.com/letta-code/selfhosting/)) and
offer a "Local runtime" whose state is a file tree. The pivot is announced at
[letta.com/blog/our-next-phase/](https://www.letta.com/blog/our-next-phase/) (2026-03-16): "We are
sunsetting a set of server-side features in favor of stronger client-side and runtime-native
replacements."
**Language / SDK:** V1 was Python ≥3.11; the current product is TypeScript on Bun, npm
`@letta-ai/letta-code` 0.30.27, with `@letta-ai/letta-client` and a Letta Agent SDK for TS.
**Fit:** Letta solves a different problem — the agent owning and rewriting its own context, with
a git history of memory edits for audit. Better than Zep for a single long-lived coding agent on
a TypeScript team. Worse for our case: no graph, no cross-user entity resolution, no temporal
invalidation, and after August 2026 no supported multi-tenant server. **Treat V1 as unusable in
production, on Letta's own written advice.**

### Cognee — `github.com/topoteretes/cognee`

**Architecture.** `CLAUDE.md` states the design: "It replaces traditional RAG … with an ECL
(Extract, Cognify, Load) pipeline combining vector search, graph databases, and LLM-powered
entity extraction." The public verbs are `remember`, `recall`, `forget`, `improve` over the older
`add` + `cognify`. `cognee/api/v1/cognify/cognify.py` composes a task list run by
`run_pipeline`: `classify_documents`, `extract_chunks_from_documents`,
`extract_graph_and_summarize`, `extract_events_and_timestamps`,
`extract_knowledge_graph_from_events`, `detect_contradictions`,
`resolve_temporal_contradictions`, `record_provenance`, `add_data_points`. The storage unit is a
`DataPoint` (`cognee/infrastructure/engine/models/DataPoint.py`), a Pydantic model with `id: UUID`,
`created_at`/`updated_at`, `ontology_valid: bool`, and a `MetaData` carrying `index_fields` and
`identity_fields` — declaring `identity_fields` makes ids deterministic so nodes merge across
runs, and the source warns that a `uuid4` id "has NO stable identity, so such a node never
deduplicates/merges across runs". Retrieval is far broader than Graphiti's: about 25 retrievers
(`graph_completion_retriever.py`, `triplet_retriever.py`, `bm25_retriever.py`,
`cypher_search_retriever.py`, `temporal_retriever.py`, `hybrid_retriever.py`,
`agentic_retriever.py`) and 23 `SearchType` members including `CYPHER` and `TEMPORAL`. Temporal
handling is **opt-in**: `resolve_temporal_contradictions.py` says "Nothing is deleted: a
superseded edge stays in the graph with its provenance, tagged (``superseded``,
``superseded_by``, ``supersession_reason``)" and "The task is a no-op unless
``functional_relationships`` is given."
Graph adapters: `ladybug` (default), `kuzu`, `neo4j`, `postgres`, `neptune`,
`neptune_analytics`, `turso`. Vector adapters: `lancedb` (default), `pgvector`,
`neptune_analytics`, `turso`. Relational: SQLAlchemy over SQLite or Postgres.
**License:** Apache-2.0 (`pyproject.toml` `license = "Apache-2.0"`, stock `LICENSE`,
`NOTICE.md` "Copyright © 2024 Topoteretes UG"). No BSL, no dual licence.
**Self-host:** the most complete stack of the five. `cognee/api/client.py` is a FastAPI app; the
root `docker-compose.yml` runs it on port 8000 with a `/health` probe plus optional `mcp` and
`postgres` profiles; `cognee-frontend/` is a Next.js UI; `deployment/helm/` is a Helm chart. The
default local stack needs no external service (SQLite + embedded Ladybug graph + LanceDB).
**Language / TS client:** Python ≥3.10. A TS client exists but with a catch: npm
`@cognee/cognee-ts` 0.2.0 is a Neon binding whose repository is
`github.com/topoteretes/cognee-rs` — **a separate Rust re-implementation**, not the Python
engine. Expect a feature gap.
**Fit:** the closest architectural peer to Graphiti and the strongest self-hosted choice. Better
than Graphiti when you ingest documents as well as chat, want ontology grounding, provenance,
many retrieval strategies, a Cypher escape hatch, and a full OSS stack with UI, MCP server and
Helm chart. Worse when you need Graphiti's strict bi-temporal edge model out of the box, since
Cognee's supersession is opt-in and requires declaring which relations hold a single value. Its
Node story is weaker than Mem0's because the npm package binds a different engine.

### Supermemory — `github.com/supermemoryai/supermemory`

**The OSS repo is not the product.** The tree is
`apps/{web,mcp,docs,browser-extension,raycast-extension,memory-graph-playground}` and
`packages/{ai-sdk,memory-graph,tools,ui,lib,hooks,validation,...}`. `apps/web` is a Next.js app
deployed to Cloudflare Workers via OpenNext, using `drizzle-orm`, `better-auth`, `hono` and `pg`.
**The memory engine, the extraction pipeline and the graph store are absent** — a grep for
`embedding` or `extractMemor` in `apps/web/src` returns nothing, and every app depends on the
external `supermemory` SDK.
**The engine ships only as a prebuilt binary.** The launcher inside the published npm package
says so: "The SDK package only contains this small launcher. The native server binary and runtime
assets are installed by https://supermemory.ai/install." Release tag `server-v0.0.8` (2026-08-17)
attaches only platform binaries, checksums, `install.sh` and `manifest.json`. There is no server
source and no server build workflow in `.github/workflows/`, and none of the 28 public repos in
the org is the engine.
**License:** the repo is MIT ("Copyright (c) 2025 supermemory"); the TS SDK (npm `supermemory`
4.25.4) is Apache-2.0. **Neither licence covers the engine, which has no published licence file.**
**Documented claims (unverifiable):** the README claims "Extracts facts from conversations.
Handles temporal changes, contradictions, and automatic forgetting" and "User Profiles |
Auto-maintained user context — stable facts + recent activity. One call, ~50ms". The docs
describe the local server as "a single self-contained binary" with "no Docker", serving
`http://localhost:6767`, state in `./.supermemory`, and "The Supermemory graph engine, embedded —
created automatically on first boot. No database to stand up, no connection strings." **The
backing store is never named.** Note the direct contradiction: the docs call the local server
"free, open source" ([local vs enterprise](https://supermemory.ai/docs/self-hosting/local-vs-enterprise))
while the artefacts are binaries only. I flag it rather than resolve it. Also note the server is
version `0.0.8` — pre-1.0.
**Fit:** better than Zep when you want a hosted API with connectors (Google Drive, Gmail, Notion,
OneDrive, GitHub), multi-modal ingestion, a browser extension and an MCP server, on a
TypeScript-only team. Worse than both Zep Cloud *and* Graphiti for anything where memory
semantics must be auditable: you cannot read the extraction rules, the graph schema, the store or
the retrieval code. Compared with Graphiti you trade a fully inspectable Apache-2.0 library for
an opaque binary. **For us that is disqualifying** — we would be taking on the same vendor
dependency as Zep with none of Zep's published documentation, benchmarks, SOC 2 or pricing
transparency. One genuinely useful artefact from the org: the neutral harness
[supermemoryai/memorybench](https://github.com/supermemoryai/memorybench) (MIT), which drives
Supermemory, Mem0 and Zep through their hosted APIs with a swappable judge. If we ever want our
own comparison, start there.

### Zep / Graphiti — the confirmations that matter for a self-host decision

- **Graphiti is Apache-2.0 and clean** (see A9). Two cosmetic oddities: the `LICENSE` copyright
  line is the unfilled placeholder `Copyright [yyyy] [name of copyright owner]`, and the README
  has no licence section. The CLA names "Zep Software, Inc." A CLA is a relicensing option for
  *future* releases, not a risk to code already released.
- **`github.com/getzep/zep` still exists but is now an examples repo**, described as "Zep |
  Examples, Integrations, & More", with the README stating "This repository is **not** Zep's
  product or service." The Community Edition is confirmed dead: "Zep Community Edition is no
  longer supported. Its code has been moved to the `legacy/` folder." The official announcement is
  [Announcing a new direction for Zep's open source strategy](https://blog.getzep.com/announcing-a-new-direction-for-zeps-open-source-strategy/)
  (Daniel Chalef, 2025-04-02): "we've decided to stop maintaining and releasing Zep Community
  Edition" and "The existing repository will remain open under the Apache 2.0 license, but we will
  no longer provide updates or active support." The `legacy/` Go server is pinned to
  `go 1.21.5` and the frozen image `zepai/graphiti:0.3` against a current `graphiti-core` of
  0.29.3 — it will not track upstream. **Do not build on it.**
- **There is no official TypeScript client for Graphiti.** The repo has zero JS/TS files and no
  `package.json`; no repo in the `getzep` org is a Graphiti TS client; the closest npm package,
  `graphiti-sdk`, self-describes as "Unofficial SDK for ZEP Graphiti API". To reach Graphiti from
  Node we must call its FastAPI service or its MCP server ourselves — which is exactly what option
  (a) in B4 costs.
- **A graph database is mandatory for Graphiti.** There is no pgvector or SQLite driver. Combined
  with the absent vector index (A6), that is the operational core of the build-versus-buy
  argument.

### Where each is a better or worse fit for *us*, in one line each

- **Zep Cloud** — best fit today. Already a dependency, priced below our own LLM cost, sub-second
  retrieval, and someone else operates the graph. Downside: closed, and the API is churning
  (February 2026 deprecations).
- **Graphiti** — best engine to *read and steal from*. Worst runtime fit: Python plus a graph DB
  plus no vector index.
- **Mem0 (`mem0ai/oss`)** — best fit if we decide to own the write path in TypeScript. Has a
  Turbopuffer adapter. Accept that we lose the temporal model, or port
  `resolve_edge_contradictions` on top of it.
- **Letta** — wrong shape for a multi-user memory service. Interesting only if we want a
  single agent that edits its own git-tracked context.
- **Cognee** — the option to revisit if we ever need document-grade memory with ontologies and
  provenance and are willing to run Python.
- **Supermemory** — no. Same vendor lock-in as Zep with less transparency and a pre-1.0 server.

---

# Confidence and gaps

## High confidence (read directly from source at a pinned commit)

Everything in A2, A3, A4, A5, A6 and A9, and the Graphiti-side claims in A1 and B1. I cloned
`github.com/getzep/graphiti` at commit `10374d6044f91b9ecae3586828abb1ecbf022c4f`
(`graphiti-core` 0.29.3, committed 2026-08-18) and read the files named. The Zep Cloud SDK
claims in A1 come from the `@getzep/zep-cloud@3.10.0` package installed in `-dimension-ai-web`'s pnpm
store, which is the published artefact.

Everything in B0 was read from `-dimension-ai-web`'s own files, and the Zep Cloud API surface came from the
`@getzep/zep-cloud@3.10.0` package in our own `node_modules`.

## Medium-high confidence (read from source, but not by me directly)

The Zep documentation and pricing figures in A1, A7 and A8, and the whole of B5, come from
delegated research passes that cloned each repository and fetched each page. Every claim carries
its file path or URL, and quoted numbers are verbatim, but I did not personally re-read every one
of those files. If a specific number in B5 is load-bearing for a decision, verify it at the
commit named in the source list before acting.

## Medium confidence

- **The LLM call counts in A3 are my arithmetic, not a published figure.** I derived them by
  enumerating every `prompt_name=` call site and its guard conditions. I did not instrument a
  running system. The ranges are plausible; the exact numbers for a given episode depend on how
  many entities and edges the extractor emits and how populated the graph already is.
- **The effort estimates in B4 are judgement, not measurement.** They assume one engineer who
  knows `-dimension-ai-web`. The eval line item is the one I would expect to slip.
- **Zep Cloud's internals.** Everything about the Context Graph Engine, the proprietary
  extraction models, the reranker and the embedding models comes from Zep's own docs and
  marketing. There is no code and no paper. I cannot verify any of it.

## Could not verify

- **The "sub-200ms performance at scale" and "P95 < 200ms" figures** have no published
  methodology. Vendor marketing.
- **`web.archive.org` was not reachable** from this environment, so I could not read the
  original May 2025 text of Zep's Mem0 rebuttal containing the withdrawn "84%" claim. I verified
  it indirectly from the title of [zep-papers issue #5](https://github.com/getzep/zep-papers/issues/5)
  and the correction banner on the live blog post.
- **No verbatim example** of the entities, episodes, observations or thread-summary sections of
  the Zep Cloud context block is published anywhere in the docs. Only the user-summary + facts
  example exists ([Retrieving context](https://help.getzep.com/retrieving-context)). Treat the
  full shape as undocumented.
- **Enterprise pricing** is "contact sales" with no published numbers. Not modelled.
- **No independent replication** of either Zep's or Mem0's benchmark claims. Both sides use LLM
  judges, both are the vendor evaluating itself, and the one attempted cross-check
  ([zep-papers issue #5](https://github.com/getzep/zep-papers/issues/5)) ended with the parties
  disagreeing and the issue closed for inactivity.
- **Graphiti's GitHub star count** — the README uses a dynamic badge and I did not query the API.
  Do not cite a figure.
- **`docs.getzep.com` does not exist** as a separate site; it redirects to
  `help.getzep.com/concepts`.
- **Supermemory's engine internals** — language, backing store, extraction rules, graph schema —
  are all undisclosed. The docs call the local server "open source" while the released artefacts
  are binaries only. I flag the contradiction rather than resolve it.
- **`github.com/getzep/zep/issues/405`** ("Question about LOCOMO benchmark results inconsistency
  with mem0 paper") is unreadable: issues are disabled on that repo and the URL returns 404.
- **`https://mem0.ai/research-2`** now returns 404, so the older restatement of Mem0's paper
  numbers is not verifiable at that URL.
- **ECAI 2025 as the venue** for arXiv:2504.19413 is asserted by Mem0 but is not in the arXiv
  record.
- **Zep's "91.6%" figure for Mem0** on its comparison page matches no number in
  `mem0ai/memory-benchmarks`, which publishes 92.5 (top-200) and 91.8 (top-50). Zep does not say
  which run it used.
- **Zep's "10 independent runs" claim** could not be verified: the scripts on `zep-papers` `main`
  show a single pass. The 10-run artefacts are said to live on a `locomo-fix` branch with no
  readable README at that ref.
- **No Cognee LoCoMo number exists** — `cognee/eval_framework/benchmark_adapters/` has no LoCoMo
  adapter. Cognee's own BEAM report is candid: "Cognee reached **0.79** on the primary 100K
  evaluation and **0.67** in an exploratory 10M scale check", with the 10M result labelled
  "in-sample exploratory". Those scale points do not match Mem0's, so the two are not comparable.
- **`@getzep/zep-cloud` declares no `license` field in `package.json`**, so npm reports no
  licence, although the package ships an Apache-2.0 `LICENSE` file.
- **Three follow-up benchmark papers** were seen only as titles and not read: Locomo-Plus
  (arXiv 2602.10715), MemoryArena (arXiv 2602.16313), LongMemEval-V2 (arXiv 2605.12493).

## Vendor marketing versus measured

| Claim | Status |
|---|---|
| "sub-200ms performance at scale", "P95 < 200ms" | Marketing. No methodology. |
| "State of the Art in Agent Memory" | Marketing headline over a self-run benchmark. |
| DMR 94.8% vs MemGPT 93.4% | Measured, but the MemGPT row is cited from another paper, and the same-harness gap versus full-context is ~2 questions. The authors themselves call the benchmark inadequate. |
| LongMemEval 71.2% vs 60.2% full-context | Measured, single run, no error bars, self-judged with GPT-4o, ingestion cost excluded. |
| "90% latency reduction" | Measured end-to-end, but it is mostly a consequence of sending 1.4% of the tokens. Not a retrieval-speed claim. Network latency was one-sided against Zep. |
| LoCoMo 94.7% (research page, 2026) | Measured with gpt-5.4 as reader and judge, no baseline published, five parallel searches rather than the default single call (which scores 86.5%). |
| Retrieval-tradeoff sweep (69.62% → 80.32%) | The most methodologically transparent Zep publication: 50 runs, stated depths, stated token counts. |

## What may be out of date

- **The paper describes a January 2025 system that no longer matches the product.** Context Graph
  Engine, Context Lake, Observations and Smart Context Assembly appear in no publication.
- **Our installed `@getzep/zep-cloud@3.10.0` is behind the docs.** It still declares the `mode`
  and `minRating` parameters that the
  [February 2026 deprecation wave](https://help.getzep.com/february-2026-deprecation-wave)
  removes, and its `GraphSearchScope` lacks `thread_summaries`, `observations` and `auto`. If we
  invest in Zep, upgrade the SDK first and re-read that deprecation page.
- **Graphiti moves fast.** `SagaNode`, `combined_extraction.py` and the `spec/` directory are all
  newer than the paper. The Kuzu driver is deprecated. Re-read the source before acting on A3 or
  A6 more than a month from now.

## One thing I would want to know before deciding, and could not learn from any source

How many episodes per user per day we actually generate, and what our current memory failure
mode is. Every number in Part B is sensitive to that, and it is measurable in a week by shipping
option (d).

# Sources

All fetched or read on **2026-08-20**.

## Graphiti source code

Pinned commit
[`10374d6044f91b9ecae3586828abb1ecbf022c4f`](https://github.com/getzep/graphiti/tree/10374d6044f91b9ecae3586828abb1ecbf022c4f)
(`graphiti-core` 0.29.3).

- [`README.md`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/README.md) — "Graphiti and Zep", "Zep vs Graphiti", backend requirements, Kuzu deprecation
- [`LICENSE`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/LICENSE) — Apache-2.0
- [`Zep-CLA.md`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/Zep-CLA.md) — contributor licence agreement
- [`pyproject.toml`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/pyproject.toml) — version, licence, dependencies, extras
- [`graphiti_core/nodes.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/nodes.py) — `EpisodeType`, `Node`, `EpisodicNode`, `EntityNode`, `CommunityNode`, `SagaNode`
- [`graphiti_core/edges.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/edges.py) — `Edge`, `EpisodicEdge`, `EntityEdge`, `CommunityEdge`, `HasEpisodeEdge`, `NextEpisodeEdge`
- [`graphiti_core/graphiti.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/graphiti.py) — `Graphiti.add_episode`, `add_episode_bulk`, `_extract_and_resolve_edges`, `_process_episode_data`, `build_indices_and_constraints`, `search`, `search_`, `summarize_saga`
- [`graphiti_core/utils/maintenance/node_operations.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/utils/maintenance/node_operations.py) — `extract_nodes`, `resolve_extracted_nodes`, `_resolve_with_llm`, `_semantic_candidate_search`, `extract_attributes_from_nodes`, `_extract_entity_summaries_batch`, constants `MAX_NODES`, `NODE_DEDUP_CANDIDATE_LIMIT`, `NODE_DEDUP_COSINE_MIN_SCORE`
- [`graphiti_core/utils/maintenance/dedup_helpers.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/utils/maintenance/dedup_helpers.py) — `_resolve_with_similarity`, `_has_high_entropy`, MinHash/LSH, thresholds
- [`graphiti_core/utils/maintenance/edge_operations.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/utils/maintenance/edge_operations.py) — `extract_edges`, `resolve_extracted_edges`, `resolve_extracted_edge`, `resolve_edge_contradictions`, `_extract_edge_timestamps`
- [`graphiti_core/utils/maintenance/community_operations.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/utils/maintenance/community_operations.py) — `label_propagation`, `build_community`, `build_communities`
- [`graphiti_core/utils/maintenance/combined_extraction.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/utils/maintenance/combined_extraction.py) — the single-call extraction path
- [`graphiti_core/prompts/extract_edges.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/prompts/extract_edges.py) — `edge`, `extract_timestamps`, `extract_attributes`, DATETIME RULES
- [`graphiti_core/prompts/dedupe_edges.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/prompts/dedupe_edges.py) — `resolve_edge`, `EdgeDuplicate`
- [`graphiti_core/prompts/dedupe_nodes.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/prompts/dedupe_nodes.py) — `nodes`
- [`graphiti_core/prompts/extract_nodes.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/prompts/extract_nodes.py) — `extract_message`, `extract_text`, `extract_json`, `extract_summaries_batch`
- [`graphiti_core/prompts/lib.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/prompts/lib.py) — the prompt library index
- [`graphiti_core/search/search.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/search/search.py) — `search`, `edge_search`, `node_search`, reranker dispatch
- [`graphiti_core/search/search_config.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/search/search_config.py) — search-method and reranker enums
- [`graphiti_core/search/search_config_recipes.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/search/search_config_recipes.py) — the 16 recipes
- [`graphiti_core/search/search_utils.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/search/search_utils.py) — `rrf`, `maximal_marginal_relevance`, `node_distance_reranker`, `node_similarity_search`, `node_bfs_search`, default constants
- [`graphiti_core/search/search_helpers.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/search/search_helpers.py) — `search_results_to_context_string`
- [`graphiti_core/graph_queries.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/graph_queries.py) — `get_range_indices`, `get_fulltext_indices`, `get_vector_cosine_func_query`
- [`graphiti_core/driver/driver.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/driver/driver.py) — `GraphProvider`
- [`graphiti_core/driver/kuzu_driver.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/driver/kuzu_driver.py), [`neptune_driver.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/driver/neptune_driver.py), [`falkordb_driver.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/driver/falkordb_driver.py)
- [`graphiti_core/cross_encoder/openai_reranker_client.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/cross_encoder/openai_reranker_client.py), [`bge_reranker_client.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/cross_encoder/bge_reranker_client.py)
- [`graphiti_core/llm_client/openai_base_client.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/llm_client/openai_base_client.py), [`anthropic_client.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/llm_client/anthropic_client.py), [`config.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/llm_client/config.py)
- [`graphiti_core/helpers.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/helpers.py) — `SEMAPHORE_LIMIT`, `semaphore_gather`
- [`graphiti_core/telemetry/telemetry.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/telemetry/telemetry.py)
- [`server/README.md`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/server/README.md), [`server/graph_service/routers/ingest.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/server/graph_service/routers/ingest.py), [`retrieve.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/server/graph_service/routers/retrieve.py), [`dto/retrieve.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/server/graph_service/dto/retrieve.py)
- [`mcp_server/README.md`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/mcp_server/README.md), [`mcp_server/src/services/queue_service.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/mcp_server/src/services/queue_service.py)
- [`tests/evals/eval_cli.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/tests/evals/eval_cli.py), [`eval_e2e_graph_building.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/tests/evals/eval_e2e_graph_building.py), [`graphiti_core/prompts/eval.py`](https://github.com/getzep/graphiti/blob/10374d6044f91b9ecae3586828abb1ecbf022c4f/graphiti_core/prompts/eval.py)

## Zep Cloud SDK (published artefact, read from `-dimension-ai-web`'s pnpm store)

`@getzep/zep-cloud@3.10.0`, Apache-2.0. Files: `LICENSE`, `package.json`, `reference.md`,
`dist/cjs/api/types/{Reranker,GraphSearchScope,EntityEdge,ThreadContextResponse}.d.ts`,
`dist/cjs/api/resources/graph/client/requests/GraphSearchQuery.d.ts`,
`dist/cjs/api/resources/thread/{types/ThreadGetUserContextRequestMode,client/requests/ThreadGetUserContextRequest}.d.ts`.
Package page: [npmjs.com/package/@getzep/zep-cloud](https://www.npmjs.com/package/@getzep/zep-cloud).

## Zep documentation and marketing

- [help.getzep.com/zep-vs-graphiti](https://help.getzep.com/zep-vs-graphiti) — the authoritative split
- [help.getzep.com/llms.txt](https://help.getzep.com/llms.txt) — full API surface index
- [help.getzep.com/february-2026-deprecation-wave](https://help.getzep.com/february-2026-deprecation-wave) — Sessions→Threads, Groups→Graphs, fact ratings removed, `mode` removed
- [help.getzep.com/retrieving-context](https://help.getzep.com/retrieving-context) — the context block, verbatim example
- [help.getzep.com/context-types](https://help.getzep.com/context-types) — the six context types
- [help.getzep.com/context-templates](https://help.getzep.com/context-templates) — `%{...}` template syntax
- [help.getzep.com/sdk-reference/graph/add-data](https://help.getzep.com/sdk-reference/graph/add-data) — `graph.add`, HTTP 202
- [help.getzep.com/sdk-reference/graph/search](https://help.getzep.com/sdk-reference/graph/search) — scopes, rerankers, limits
- [help.getzep.com/graphiti/core-concepts/graph-namespacing](https://help.getzep.com/graphiti/core-concepts/graph-namespacing) — `group_ids`
- [help.getzep.com/rate-limits](https://help.getzep.com/rate-limits) — RPM, headers
- [help.getzep.com/faq](https://help.getzep.com/faq) — what `get_user_context` does, ingestion latency, sequential processing, Community Edition deprecated
- [getzep.com/pricing](https://www.getzep.com/pricing) — credit model, tiers, RPM
- [getzep.com/](https://www.getzep.com/) — positioning
- [getzep.com/research/](https://www.getzep.com/research/) — current LoCoMo and LongMemEval numbers and methodology
- [getzep.com/platform/context-graph-engine/](https://www.getzep.com/platform/context-graph-engine/) — the proprietary store
- [getzep.com/mem0-alternative/](https://www.getzep.com/mem0-alternative/) — Zep's competitor comparison

## Papers and benchmark disputes

- [arXiv:2501.13956](https://arxiv.org/abs/2501.13956) / [HTML v1](https://arxiv.org/html/2501.13956v1) — "Zep: A Temporal Knowledge Graph Architecture for Agent Memory", Rasmussen, Paliychuk, Beauvais, Ryan, Chalef, 20 Jan 2025, v1 only
- [github.com/getzep/zep-papers](https://github.com/getzep/zep-papers) — the only Zep publication
- [blog.getzep.com/state-of-the-art-agent-memory/](https://blog.getzep.com/state-of-the-art-agent-memory/) — paper announcement
- [blog.getzep.com/graphiti-knowledge-graphs-for-agents/](https://blog.getzep.com/graphiti-knowledge-graphs-for-agents/) — Graphiti announcement, 28 Aug 2024
- [blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/) — Zep's rebuttal and its own correction to 75.14% ±0.17
- [github.com/getzep/zep-papers/issues/5](https://github.com/getzep/zep-papers/issues/5) — Mem0's counter-rebuttal and Zep's reply
- [blog.getzep.com/the-retrieval-tradeoff-what-50-experiments-taught-us-about-context-engineering/](https://blog.getzep.com/the-retrieval-tradeoff-what-50-experiments-taught-us-about-context-engineering/) — 50-run retrieval-depth sweep

## Alternatives (repos read at the commits named, plus official docs)

- **Mem0** — [github.com/mem0ai/mem0](https://github.com/mem0ai/mem0) at `001c2352`
  (2026-08-14), `mem0ai` 2.0.18. Files: `LICENSE`, `pyproject.toml`, `mem0/memory/main.py`
  (`Memory`, `_add_to_vector_store`, `_search_vector_store`), `mem0/configs/prompts.py`
  (`ADDITIVE_EXTRACTION_PROMPT`, `DEFAULT_UPDATE_MEMORY_PROMPT`, `get_update_memory_messages`),
  `mem0/memory/storage.py` (`SQLiteManager`), `mem0/utils/{entity_extraction,scoring}.py`,
  `mem0/vector_stores/`, `server/{README.md,docker-compose.yaml}`, `mem0-ts/package.json`,
  `docs/migration/oss-v2-to-v3.mdx`, `docs/changelog/highlights.mdx`,
  [docs.mem0.ai/core-concepts/memory-evaluation](https://docs.mem0.ai/core-concepts/memory-evaluation).
  Paper: [arXiv:2504.19413](https://arxiv.org/abs/2504.19413). Benchmarks:
  [github.com/mem0ai/memory-benchmarks](https://github.com/mem0ai/memory-benchmarks).
- **Letta** — [github.com/letta-ai/letta](https://github.com/letta-ai/letta) at `87fd37aa`
  (2026-08-15; `README.md`, `LICENSE`, `TERMS.md`); the `archive` branch (`letta` 0.16.8,
  `letta/schemas/{block,memory}.py`, `letta/orm/`, `letta/functions/function_sets/base.py`,
  `letta/groups/sleeptime_multi_agent*.py`, `compose.yaml`);
  [github.com/letta-ai/letta-code](https://github.com/letta-ai/letta-code)
  (`src/agent/memory-git.ts`, `src/backend/backend-mode.ts`, `package.json`, `LICENSE`);
  [docs.letta.com/self-hosting](https://docs.letta.com/self-hosting),
  [docs.letta.com/letta-code/selfhosting](https://docs.letta.com/letta-code/selfhosting/),
  [letta.com/blog/our-next-phase/](https://www.letta.com/blog/our-next-phase/).
- **Cognee** — [github.com/topoteretes/cognee](https://github.com/topoteretes/cognee) at
  `fd5045f6` (2026-08-19), `cognee` 1.5.0. Files: `LICENSE`, `NOTICE.md`, `pyproject.toml`,
  `CLAUDE.md`, `cognee/api/client.py`, `cognee/api/v1/cognify/cognify.py`,
  `cognee/infrastructure/engine/models/DataPoint.py`,
  `cognee/infrastructure/databases/graph/get_graph_engine.py`,
  `cognee/infrastructure/databases/vector/create_vector_engine.py`,
  `cognee/modules/retrieval/`, `cognee/tasks/graph/resolve_temporal_contradictions.py`,
  `cognee/eval_framework/beam/REPORT.md`, `docker-compose.yml`, `deployment/helm/`.
  Node bindings: npm `@cognee/cognee-ts` 0.2.0 →
  [github.com/topoteretes/cognee-rs](https://github.com/topoteretes/cognee-rs).
- **Supermemory** — [github.com/supermemoryai/supermemory](https://github.com/supermemoryai/supermemory)
  at `818a83a3` (2026-08-19). Files: `LICENSE` (MIT), `README.md`, `apps/web/wrangler.jsonc`,
  release tag `server-v0.0.8`. npm `supermemory` 4.25.4 launcher (`bin/cli`).
  Docs: [supermemory.ai/docs/self-hosting/overview](https://supermemory.ai/docs/self-hosting/overview),
  [.../local-vs-enterprise](https://supermemory.ai/docs/self-hosting/local-vs-enterprise),
  [supermemory.ai/research](https://supermemory.ai/research). Harness:
  [github.com/supermemoryai/memorybench](https://github.com/supermemoryai/memorybench).
- **Zep OSS strategy** — [github.com/getzep/zep](https://github.com/getzep/zep) (now an examples
  repo; `legacy/` holds the discontinued Go Community Edition) and
  [Announcing a new direction for Zep's open source strategy](https://blog.getzep.com/announcing-a-new-direction-for-zeps-open-source-strategy/)
  (2025-04-02).

## Benchmark datasets and independent critique

- [arXiv:2402.17753](https://arxiv.org/abs/2402.17753) and
  [github.com/snap-research/locomo](https://github.com/snap-research/locomo) — the LoCoMo dataset
  and its authors' own limitations section; open label-error issues
  [#27](https://github.com/snap-research/locomo/issues/27),
  [#35](https://github.com/snap-research/locomo/issues/35),
  [#42](https://github.com/snap-research/locomo/issues/42)
- [github.com/dial481/locomo-audit](https://github.com/dial481/locomo-audit) — independent audit:
  6.4% wrong golden answers, 93.57% scoring ceiling, 62.81% judge false-accept rate
- [arXiv:2607.21962](https://arxiv.org/abs/2607.21962) — follow-up paper citing that audit

## Alfred (this repository)

`docs/decisions/ADR-0058-memory-store-the-postgres-substrate-over-a.md` — the
build-vs-buy decision this note checks. Supporting ADRs read for section 0:
`ADR-0001` (single user), `ADR-0012` (structured tables + pgvector), `ADR-0019`
and `ADR-0056` (the `user_facts` status machine and the reversibility UX),
`ADR-0038` (content-at-rest posture), `ADR-0067` (observation-log substrate).
Schema: `packages/db/src/schema/memory.ts`, `packages/db/src/schema/user-model.ts`,
`packages/db/src/helpers.ts`, `packages/db/src/migrations/0023_halfvec_embedding_indexes.sql`.
Code: `packages/ai/src/embeddings.ts`, `packages/ai/src/provider.ts`,
`packages/assistant/src/knowledge/`. Plans:
`docs/plans/long-term-memory-v1.md`, `docs/plans/identity-facts-projection-v1.md`,
`docs/plans/user-model-p1-gmail-shadow.md`.

## `-dimension-ai-web` (the sibling repo Part B is costed against)

`package.json`, `packages/models/package.json`, `packages/services/package.json`,
`packages/jobs/package.json`, `packages/trpc/package.json`,
`packages/backend-lib/package.json`, `packages/backend-lib/embeddings/index.ts`,
`packages/backend-lib/turbopuffer/{client.ts,helpers.ts,artifacts-ns.ts,ns-cache.ts,constants.ts}`,
`packages/models/drizzle/schemas/`, `packages/events/{index.ts,config/streams.ts}`,
`packages/events/events/memory/manage-state.event.ts`,
`packages/publishers/memory/manage-state.publisher.ts`,
`packages/trpc/server/routers/auth.router.ts`,
`packages/trpc/server/utils/process-db-queue-events.ts`,
`packages/trpc/server/mutators/threads.mutator.ts`,
`packages/jobs/delete-account.consumer.ts`,
`apps/consumers/src/register-consumers.ts`, `apps/ai-export/package.json`.
