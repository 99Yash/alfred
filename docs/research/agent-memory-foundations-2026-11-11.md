# Agent memory foundations: resolve the mention, learn from the user, keep time

Status: Research, 2026-11-11. No runtime change. Repo facts are verified at `63a53cfba`.

## The question

Alfred needs a foundational model for long-term agent memory. The model must do four jobs:

- **(a) Resolve a mention.** A mention is a phrase that names a thing, for example "Alfred" or "the Air vs mini decision". A referent is the thing that the mention names. The agent must find the referent without a search, and it must not guess before it resolves.
- **(b) Learn only from the user.** Only the user's own acts and words are evidence. The model's own outputs are not evidence.
- **(c) Keep provenance and time.** Each statement keeps its source, its event time, its record time, its successor, and any user correction.
- **(d) Split push from pull.** Decide what goes into the model context at run start, and what the model reads by a tool.

**The fault that started this note.** The owner reports this production trace. The user asked chat for "Alfred's issues". The model searched docs and found `99Yash/alfred` by chance. Alfred already held 94 PR rows and about 10,000 GitHub documents for that repo, and the user's GitHub login. The owner says that the fault is not about repos. It applies to any thing that the user discussed or acted on. The agent must resolve the mention before it acts, and it must not use a shortcut rule such as "assume the user's own repo".

**Sources that did not load.** The OpenAI help pages returned HTTP 403 to WebFetch and to `curl` (`help.openai.com/en/articles/11146739`, `.../8590148-memory-faq`, `.../8590148-memory-in-chatgpt`). The OpenAI blog post also returned 403. The Internet Archive was not reachable from this tool. Section 1.9 uses only search-index text for OpenAI, and it marks that text as unverified.

---

## 1. The sources

### 1.1 Anthropic, "The components of agent memory" (Lance Martin, 2026-11-06)

URL: https://www.anthropic.com/research/components-of-agent-memory

- **Primitives.** The article names four layers: transcripts, memory notes, memory representations (for example a wiki), and injected context. "Dreaming" is an offline process that moves information between the layers (section "The components of agent memory").
- **Ground truth.** "Agents capture much of their work in logs or transcripts." Also: "The transcript gave Claude a ground truth to validate its memory against" (section "Dreaming can correct memory").
- **Write path.** Claude writes memory notes during a session. "Memory is, occasionally, a prediction" about what the future needs (section "Memory can be a prediction about what the future will need"). Dreaming also writes notes and representations offline.
- **Read path.** Injected context loads "at the start of every session". For Claude Code auto memory, "It loads only the first 200 lines or 25 KB of `MEMORY.md`." The lower layers are read or searched on demand.
- **Hybrid read wins.** "Claude's aggregate score rose from 54% to 61% as that wiki grew", "compared with 53% when it had access to the search tool alone".
- **Conflict.** Several agents wrote to one shared table. "Claude had included only 41 of the 57 facts (72%)", "because agents had overwritten one another's work". One page per contract fixed it.
- **Staleness.** "Memory can also drift and become irrelevant as the environment changes."
- **Failure modes.** "Claude can make incorrect predictions or write rules to memory that are wrong from the start." In the Pokemon run, Claude "wrote down (incorrectly) that the PokéCenter was on the east side". With the wrong note, the run failed again and again. A dreaming pass checked the note against the transcript and fixed it. Sonnet 3.7 "wrote to memory indiscriminately" (section "Claude has learned to judge salience").

**Lesson for Alfred.** A note that the model writes can be wrong, and the error spreads to every session. The fix in the article is a check against the raw log. This supports (b): the raw user acts are the ground truth, and model notes are claims to check.

### 1.2 Anthropic, context engineering post

URL: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

- **Just-in-time read.** Agents "maintain lightweight identifiers (file paths, stored queries, web links, etc.)" and load data by tool when they need it (section "Context retrieval and agentic search").
- **Hybrid.** Claude Code loads `CLAUDE.md` files at the start and uses glob and grep for other files (same section).
- **Context rot.** As the context grows, recall accuracy falls (section "Why context engineering is important to building capable agents").
- **Notes.** "Structured note-taking, or agentic memory, is a technique where the agent regularly writes notes" outside the window (section "Structured note-taking").

**Lesson for Alfred.** Push identifiers, not content. An identifier is small, and it removes the search for a known thing.

### 1.3 Claude memory tool

URL: https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool (the `docs.claude.com` URL redirects here)

- **Primitives.** A client-side directory under `/memories`. The commands are `view`, `create`, `str_replace`, `insert`, `delete`, and `rename` (section "Tool commands"). Your application owns the storage (section "How it works").
- **Read path.** The API adds this text to the system prompt: "IMPORTANT: ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE." (section "Prompting guidance"). So the first read is a pull, but the prompt forces it at the start.
- **Write path.** The model writes files as it works. The docs suggest a scope rule: "Only write down information relevant to <topic> in your memory system."
- **Staleness.** "Periodically delete memory files that haven't been accessed in a long time" (section "Memory expiration").
- **Safety.** The handler must reject paths outside `/memories` (section "Path traversal protection"). Claude "usually refuses" to store sensitive data, and the docs advise validation for a stronger guarantee (section "Sensitive information").

**Lesson for Alfred.** The tool has no provenance and no time model. It is a file store that the model edits. It does not meet (b) or (c) alone.

### 1.4 MemGPT paper (arXiv 2310.08560) and Letta docs

URLs: https://arxiv.org/html/2310.08560, https://docs.letta.com/guides/agents/memory-blocks, https://docs.letta.com/guides/agents/context-hierarchy

- **Primitives (MemGPT section 2.1).** Main context has three parts: system instructions, working context, and a FIFO message queue. "Working context is a fixed-size read/write block of unstructured text, writeable only via MemGPT function calls." The first queue item is a recursive summary of old messages.
- **External context (section 2.2).** Recall storage holds the full message log. Old messages "are stored indefinitely in recall storage and readable via MemGPT function calls". Archival storage is "a read/write database storing arbitrary length text objects".
- **Memory pressure (section 2.2).** A queue manager adds a warning at a threshold (for example 70% of the window). At the flush threshold, it evicts messages and updates the summary.
- **Write path.** Edits are self-directed by the model through function calls (section 2.3). The queue manager logs both input and output to recall storage (section 2.2).
- **Failure modes (sections 3.2.1, 3.2.2).** "MemGPT will often stop paging through retriever results before exhausting the retriever database." With nested lookups, the model "does not perform enough lookups". GPT-3.5 degrades because of weak function calls.
- **Letta memory blocks.** Blocks "are always visible - no retrieval needed". Each block has `label`, `description`, `value`, `limit`, and `read_only`. "The description is the main information used by the agent to determine how to read and write to that block." Blocks "are simply prepended to the agent's prompt in an XML-like format". A write to `value` "completely replaces the entire block content", so concurrent writes can overwrite.
- **Letta hierarchy.** Memory blocks are the only always-in-context source. The page advises fewer than 20 blocks and about 50k characters for each. Archival memory is "a general-purpose vector DB" that the agent reads by `archival_memory_search` (context-hierarchy page).

**Lesson for Alfred.** The tier split (small pushed core, large pulled archive) is the base pattern. The reported failure is the Alfred fault: the model stops its lookups early, or it does not look up at all. A pushed index removes that step for known things.

### 1.5 Zep and Graphiti (arXiv 2501.13956)

URLs: https://arxiv.org/html/2501.13956, https://help.getzep.com/graphiti/getting-started/overview

- **Primitives (section 2).** Three subgraphs: episodes, semantic entities, and communities. Episodes hold the raw input with a reference time. Episodes and derived edges keep two-way links, so each fact traces back to its source (section 2.1).
- **Entity resolution (section 2.2.1).** Extraction reads the current message plus the last n = 4 messages. "The speaker is always extracted as an entity." Names are embedded (1024 dimensions) and also searched by full text. An LLM decides if a candidate is a duplicate.
- **Facts (section 2.2.2).** Facts are edges between entities. Dedup searches only edges between the same entity pair.
- **Time (section 2.2.3).** Four timestamps: `t'created` and `t'expired` on the record timeline, `t_valid` and `t_invalid` on the world timeline. An LLM finds a contradiction, and the old edge is invalidated, not deleted. "Graphiti consistently prioritizes new information when determining edge invalidation."
- **Read path (section 3).** Search (cosine, BM25, breadth-first graph search), then rerank, then a constructor that writes facts with their validity dates into a context string. "The initial search methods aim to achieve high recall, rerankers serve to increase precision."
- **Results (section 4.3.2).** On LongMemEval with gpt-4o, Zep scored 71.2% against 60.2% for full context. Context fell from about 115k to 1.6k tokens.
- **Failure modes.** The single-session-assistant question type fell by 17.7% (gpt-4o) and 9.06% (gpt-4o-mini) (section 4.3.2). The authors say weaker models may need more work to read the temporal data. Incremental communities drift, and "periodic community refreshes remain necessary" (section 2.3).

**Lesson for Alfred.** Episodes plus bi-temporal edges plus invalidation is the strongest published model for (c). Two parts do not fit Alfred. First, "new information wins" is wrong when the new item is a model inference and the old item is a user correction. Second, the speaker rule extracts the assistant too, so the graph can learn from the model.

### 1.6 Mem0 (arXiv 2504.19413)

URL: https://arxiv.org/html/2504.19413

- **Input (section 2).** "The system processes a pair of messages between either two user participants or a user and an assistant." The pair is usually a user message and an assistant reply.
- **Write path (section 2.1).** Inputs are the new pair, a running summary, and the last m = 10 messages. An LLM extracts candidate facts. For each fact, the system reads the top s = 10 similar memories. An LLM tool call picks ADD, UPDATE, DELETE, or NOOP. DELETE is the "removal of memories contradicted by new information".
- **Graph variant (section 2.2).** Mem0g extracts entities and triplets. A threshold on embedding similarity decides node reuse. Obsolete relations are marked invalid "rather than physically removing them to enable temporal reasoning".
- **Results (section 4).** Overall LLM-judge scores: Mem0 66.88%, Mem0g 68.44%, full context 72.90%. Mem0 p95 total latency is 1.440 s against 17.117 s for full context.
- **Failure modes.** The base variant deletes, so it loses history. The paper says the OpenAI memory baseline scored poorly on temporal questions because its memories had no timestamps (section 4).

**Lesson for Alfred.** The four-way write decision is a useful vocabulary. A physical DELETE breaks (c). The input pair includes the assistant turn, which breaks (b) unless a filter removes it.

### 1.7 Generative Agents (arXiv 2304.03442)

URL: https://arxiv.org/html/2304.03442

- **Primitive (section 4.1).** The memory stream. Each entry has "a natural language description, a creation timestamp, and a most recent access timestamp".
- **Read path (section 4.1).** The score is recency plus importance plus relevance. Recency decays by a factor of 0.995 per game hour since the last read. An LLM rates importance from 1 to 10 when the memory is made. Relevance is embedding cosine.
- **Reflection (section 4.2).** Reflection runs when the sum of recent importance scores passes 150. The output cites its evidence ("insight (because of 1, 5, 3)"), and the stream stores "pointers to the memory objects that were cited".
- **Failure modes (section 6.5.2).** Agents "can fail to retrieve the correct instances from their memory". "At times, the agents hallucinated embellishments to their knowledge."

**Lesson for Alfred.** Reflection with citations is a good provenance rule. Importance from an LLM rating is a form of self-learning. For Alfred, a count of user acts is a better salience signal than a model rating.

### 1.8 A-MEM (arXiv 2502.12110)

URL: https://arxiv.org/html/2502.12110

- **Primitive (section 3.1).** A note with content, timestamp, keywords, tags, context, embedding, and links. An LLM writes the keywords, tags, and context.
- **Links (section 3.2).** Cosine top-k candidates, then an LLM picks the links.
- **Evolution (section 3.3).** When a new note arrives, an LLM can rewrite the context, keywords, and tags of its neighbors. The updated memory replaces the original.
- **Failure modes (section 6, section 4.5).** Quality "may still be influenced by the inherent capabilities of the underlying language models". A larger k "may also introduce noise".

**Lesson for Alfred.** Evolution in place is the opposite of (b) and (c). The model rewrites old memory, and the old form is lost.

### 1.9 LangMem and OpenAI ChatGPT memory

URL: https://langchain-ai.github.io/langmem/concepts/conceptual_guide/

- **LangMem primitives.** Semantic memory (facts), episodic memory (past experiences), and procedural memory (instructions). Semantic memory has two shapes. A collection is many records that "must reconcile new information with previous beliefs". A profile is one schema document that new data overwrites.
- **LangMem write path.** The hot path writes during the conversation and "adds perceptible latency". The background path writes after the conversation and "is perfect for ensuring higher recall of extracted information".
- **LangMem failure modes.** Over-extraction lowers precision. Under-extraction lowers recall.

**OpenAI ChatGPT memory (unverified: the pages returned 403).** The search index shows this text for the help page https://help.openai.com/en/articles/11146739-how-does-reference-saved-memories-work: "Reference saved memories" holds details that the user asked ChatGPT to remember. "Reference chat history" reads past chats. Unlike saved memories, "details from past chats can change over time". The index also says that a chat delete does not remove a saved memory from that chat. Confirm these points in a browser before you rely on them.

**Lesson for Alfred.** The "saved memory" form (the user asked for it) matches (b). The profile shape matches a small pushed core. The collection shape matches a pulled archive.

### 1.10 Event sourcing, CQRS, and bi-temporal history

URLs: https://martinfowler.com/eaaDev/EventSourcing.html, https://martinfowler.com/articles/bitemporal-history.html, Greg Young, "CQRS Documents" (https://cqrs.wordpress.com/wp-content/uploads/2010/11/cqrs_documents.pdf)

- **Event sourcing (Fowler).** "Event Sourcing ensures that all changes to application state are stored as a sequence of events." You can discard the state and rebuild it (section "How it Works").
- **Replay hazard (Fowler, section "External Queries").** An external query during replay can return a different answer. One fix is a gateway "that it remembers the responses to its queries". For Alfred, a model call is an external query.
- **No delete (Young, p. 31, "There is no Delete").** A delete is a new event, a "Reversal Transaction", which "leaves a trail that shows that the object had been in that state".
- **Commands and events (Young, p. 30).** Events are "verbs in the past tense". Young separates "returning to a given state" from "attempting to transition to a new one". In Alfred terms, a user act is an event. A model proposal is a command that the user can accept or reject.
- **Bi-temporal history (Fowler).** Actual (valid) time is the history "given perfect information". Record time "captures how our knowledge of history changes". A query can ask for both: `sally.salaryAt('2021-02-25', '2021-03-25')` (section "Storing and Processing Bitemporal Histories").

### 1.11 Entity linking: the "resolve a mention" primitive

URLs: https://arxiv.org/abs/2006.00575 (Sevgili et al., "Neural Entity Linking: A Survey of Models Based on Deep Learning"), https://arxiv.org/abs/1911.03814 (Wu et al., BLINK), https://arxiv.org/abs/2305.15725 (Zhu et al., "Learn to Not Link")

Entity linking is the task that maps a mention in text to one entry in a knowledge base.

- **Pipeline (Sevgili section 3.1).** Mention detection, candidate generation, ranking, and "an optional step" to find unlinkable mentions.
- **Candidate generation (section 3.1.1).** Three methods: surface-form match, an alias dictionary ("NYC" stands for "New York City"), and a prior p(e|m). The prior is the frequency with which a mention string links to an entity, for example from Wikipedia anchor text.
- **NIL prediction (section 3.1.5).** NIL is the answer "no entity in the base matches". "The NIL prediction task is essentially a classification with a reject option." Four methods: no candidate, a score threshold, a special NIL candidate, or a separate binary classifier.
- **Two-stage ranking (BLINK).** A bi-encoder retrieves candidates, and then "Each candidate is then re-ranked with a cross-encoder."
- **NIL types (Zhu et al.).** NIL prediction "has received insufficient attention". NIL mentions are a "Missing Entity" or a "Non-Entity Phrase".

**Lesson for Alfred.** This is the primitive that (a) needs. For Alfred, the knowledge base is the user's own graph. The prior p(e|m) comes from the user's acts, not from Wikipedia. The reject option is the rule "do not guess".

---

## 2. Primitives that recur in the strong systems

| # | Primitive | Where it occurs |
| - | --------- | --------------- |
| P1 | A raw, append-only log of episodes is the ground truth. | Anthropic transcripts; MemGPT recall storage; Zep episodes; Generative Agents memory stream; Fowler and Young. |
| P2 | Derived memory is a rebuildable projection with a pointer back to its source. | Zep episode-edge indices; Generative Agents reflection pointers; CQRS read models. |
| P3 | Each thing has one stable identity, and a resolution step maps new mentions to it. | Zep section 2.2.1; Mem0g node reuse; entity linking. |
| P4 | Resolution can answer "none" or "not sure". | Entity linking NIL (Sevgili section 3.1.5). No memory product above states this. |
| P5 | Time has two axes, and a conflict invalidates instead of a delete. | Zep section 2.2.3; Mem0g; Fowler bi-temporal; Young reversal. |
| P6 | A write-time conflict decision (add, update, invalidate, no change). | Mem0 section 2.1; LangMem collections; Zep invalidation. |
| P7 | A small, bounded core is pushed; a large archive is pulled. | MemGPT; Letta blocks; Anthropic injected context; Claude memory tool; LangMem profile vs collection. |
| P8 | Hybrid read: lexical plus semantic plus graph, then rerank. | Zep section 3; Anthropic wiki plus search (61% vs 53%); BLINK. |
| P9 | Offline consolidation that checks notes against the raw log. | Anthropic dreaming; Generative Agents reflection; LangMem background path. |

**What none of the memory products has.** No product above limits its evidence to the user's own acts. Mem0 reads assistant turns (section 2). MemGPT logs model output to recall (section 2.2). Zep extracts the speaker, including the assistant (section 2.2.1). Generative Agents asks the model to rate importance (section 4.1). A-MEM lets the model rewrite old notes (section 3.3). Alfred must add (b) as its own rule.

---

## 3. Alfred today: what it has and what it lacks

Terms come from `docs/theory/context-graph.md`. An event is an `observations` row (`docs/theory/context-graph.md:13`). A thing is a person, repo, PR, or other object. A projection is a table that code rebuilds from events (`docs/theory/context-graph.md:29`).

### 3.1 What Alfred has

- **P1, the log.** `observations` is the append-only system of record (`packages/db/src/schema/user-model.ts:36-38`). Each row has `occurredAt` (`:64`), a stable `familyKey` (`:66`), an `evidenceHash` (`:68`), a `subjectIdentity` (`:70`), and a `supersedesObservationId` chain (`:86`). Indexes prevent a fork in a chain (`:99-107`).
- **P2, projections.** Nodes, identities, profiles, and edges are replayable projections, rebuilt per `projection_version` (`packages/db/src/schema/user-model.ts:40-43`).
- **P3, stable identity.** `entity_nodes` has a minted id and a merge pointer (`packages/db/src/schema/user-model.ts:171-205`). `entity_identities` has typed keys with `validFrom`, `validUntil`, a supersession link, and `userPinned` (`:212-278`, `:231-235`).
- **Source authority.** The user source has rank 0, chat rank 1, and providers rank 2 (`packages/contracts/src/user-model.ts:54-73`).
- **Correction lifecycle.** `user_facts` has the statuses proposed, confirmed, rejected, edited, and superseded, plus `supersedes_id` (`packages/db/src/schema/memory.ts:35-73`). `rejected_inferences` stops a re-proposal (`packages/db/src/schema/memory.ts:343-362`).
- **Standing instructions.** A trigger raises a per-user revision at each instruction change (`packages/db/src/schema/memory.ts:83-101`).
- **P8, hybrid pull.** Chat has `system.read_user_context` and `system.search_context` (`packages/assistant/src/chat/chat-turn.ts:134-135`).
- **Provider state.** `integration_objects` holds `title`, `url`, and `repo` for each PR or ticket (`packages/db/src/schema/integration-objects.ts:36-38`).
- **Ask the user.** `system.ask_user` exists (`packages/contracts/src/tools.ts:61`).
- **The design for (c).** ADR-0111 D2b separates `occurredAt`, `recordedAt`, validity, `firstLearnedAt`, `lastSupportedAt`, and `lastVerifiedAt`. It says "Currency is evaluated when used" (`docs/decisions/ADR-0111-structured-workspace-memory-claims-sweep-curiosity.md:42-70`). Its status is PROPOSED, and D2b is "not implemented" (`:1`, `:44`).

### 3.2 What Alfred lacks

1. **No mention resolution (P3, P4).** No tool or projection maps a name to a referent. The chat prompt sends the model up a search ladder instead (`packages/assistant/src/chat/chat-turn.ts:143-144`). This is the "Alfred's issues" fault.
2. **No name or alias identities from GitHub.** The GitHub reducer writes activity rows and no identities: `identityKinds: []` (`packages/contracts/src/user-model.ts:67-72`). `github_login` and `github_repository_full_name` are forward kinds with no writer (`packages/contracts/src/user-model.ts:141-152`). So the 94 PR rows sit in `integration_objects.repo`, and no node says "the user acts on `99Yash/alfred`".
3. **No surface-name identity kind.** All identity kinds are hard keys (email, login, ids). The only alias list is on the old `entities` table (`packages/db/src/schema/memory.ts:209-212`), which gets no new readers or writers (`docs/theory/context-graph.md:72`).
4. **"Alfred" has two referents, and only one is in context.** The prompt says "You are Alfred" (`packages/assistant/src/settings/self-identity.ts:76-77`). Nothing says that the user's repo `99Yash/alfred` is also "Alfred". So the self-identity block can bias the model toward the wrong referent.
5. **The projection is not active in production** (`docs/theory/context-graph.md:81`; `docs/decisions/ADR-0111-structured-workspace-memory-claims-sweep-curiosity.md:8`).
6. **Chat writes no memory.** The chat capture workflow "Writes nothing durable yet" (`packages/assistant/src/chat/chat-memory-capture.ts:19`, `:225`). So an open matter from chat, such as the Air vs mini decision, is not a thing (`docs/theory/README.md:117`, `:142`).
7. **The model is the default author.** `user_facts.source` defaults to `{"kind":"agent"}` (`packages/db/src/schema/memory.ts:55-58`). `memory_chunks.source` has the same default (`:283-286`). A sender prior counts the model's own triage label (`docs/theory/README.md:56`). These break (b).
8. **Record time stands in for valid time.** `user_facts.validFrom` defaults to `now()` (`packages/db/src/schema/memory.ts:60`). `integration_objects.validFrom` does the same (`packages/db/src/schema/integration-objects.ts:49`). A late import thus looks like a new truth. ADR-0111 names this gap (`:70`).
9. **Three stores hold things.** `entities`, `entity_nodes`, and `integration_objects` can each hold the same PR, with no link (`docs/theory/context-graph.md:78-79`).

---

## 4. The recommended model

Name: **referent-first memory**. It has four layers. Each layer has one owner.

| Layer | What it holds | Alfred home | Who writes |
| ----- | ------------- | ----------- | ---------- |
| L0 Evidence | Every event, with its actor, event time, and record time. | `observations` | Reducers and the user. |
| L1 Referents | One record for each thing, plus its names and a salience from user acts. | `entity_nodes`, `entity_identities`, `integration_objects` | The projection only. |
| L2 Statements | Facts, claims, and instructions, with validity and citations. | `user_facts` (as a view), ADR-0111 claims | The projection only. |
| L3 Context | A bounded core at run start, and tools for the rest. | The chat grounding and tools | Code at read time. |

### 4.1 Answer to (a): resolve the mention before any search

**The primitive.** Add one read: `resolve(mention, context) -> candidates | NIL`. It is entity linking (section 1.11), with the user's graph as the knowledge base.

**Candidate generation.** Code collects candidates from three sources:

- Hard identities: an exact match on `entity_identities` (email, login, `owner/repo`).
- Names: a new surface-name identity kind (for example `name`) on each referent. The projection derives names from evidence. For a repo, the names are `owner/repo` and the bare `repo`. For a person, the names are the display names in the mail headers. For a chat matter, the names are the user's own words.
- The self: Alfred itself is a candidate for "Alfred", from `selfIdentityGrounding`.

**Features per candidate.** Code attaches facts, not a verdict (principle 4, `docs/theory/README.md:54`):

- The referent kind, and if it fits the request. "Issues" fits a repo or a tracker. It does not fit a person.
- The count of user acts on the referent: PRs authored, mails sent, chat mentions. This is the personal prior p(e|m).
- The time of the last user act.
- A user pin. `entity_identities.userPinned` already exists (`packages/db/src/schema/user-model.ts:231`).

**Decision.** The model judges the candidates. Code owns two guarantees only:

- A user pin wins. When the user once said "Alfred means `99Yash/alfred`", that pin settles the mention.
- NIL and "ambiguous" are valid results. When two candidates fit, the tool says so. The model then asks with `system.ask_user`, or it states its choice in the answer. It must not pick in silence.

**Why not a rule.** A prompt rule such as "assume the user's own repo" is a patch. It fixes one kind and breaks other kinds (principle 1, `docs/theory/README.md:43`). The prior from user acts gives the same answer for the repo case, and it also covers a person, a decision, or a vendor.

**The "Alfred's issues" trace under this model.** The candidates are Alfred itself and the repo `99Yash/alfred`. The repo has 94 PRs that the user authored. Alfred itself has no issues. The tool returns the repo first, with the counts. The model calls `github.*` for issues on that repo. No document search runs.

**What the model must build first.**

1. Activate the projection in production (`docs/theory/context-graph.md:81`).
2. Let the GitHub reducer write `github_login` and `github_repository_full_name` (`packages/contracts/src/user-model.ts:141-152`), and derive repository nodes from user activity.
3. Add the surface-name identity kind, with `canonicalizeIdentityValue` as the one normalizer.
4. Land chat capture (#399), so that a matter from chat becomes a referent with the user's words as its names.

**Trade-offs.**

- A name index can merge two things with one name. The identity row keeps `confidence` and `validUntil`, and a merge leaves a forward pointer (`packages/db/src/schema/user-model.ts:180-181`). A user pin corrects a bad merge.
- The prior favors frequent things. A rare thing with a common name loses. The NIL and "ambiguous" results limit the damage, because the model must ask.
- Zep resolves with an LLM at write time (section 1.5). This model resolves at read time, with code candidates and a model choice. Read time keeps the projection deterministic, but each turn pays one tool call.

### 4.2 Answer to (b): learn only from the user's acts

**The rule.** Each observation names its actor: `user`, `provider`, or `model`. Only `user` rows can create or raise a preference, a salience, or a fact about the user. `provider` rows can set object state (`docs/theory/context-graph.md:19`). `model` rows are proposals, in Young's sense of a command (section 1.10). They change nothing until a user act confirms them.

**What counts as a user act.** A sent mail, a reply, an authored or merged PR, and a calendar accept are user acts. A typed chat message, a correction, a dismiss, and a confirm are also user acts. The chat proposition schema already separates `user_assertion`, `user_correction`, `user_confirmation`, and `user_rejection` from `alfred_enrichment` (`packages/contracts/src/chat-memory.ts:42-49`). Keep that split in the log.

**What does not count.** A triage label, a briefing line, an assistant turn, an extraction with high model confidence, and a reflection. ADR-0111 D2 already says that "The model never reports its own confidence" (`docs/decisions/ADR-0111-structured-workspace-memory-claims-sweep-curiosity.md:22`). The ADR-0019 auto-confirm at confidence above 0.85 conflicts with this rule (`docs/decisions/ADR-0019-memory-correction-loop-ux.md:7`). Remove it, or base it on grounding, not on model confidence.

**Model interpretations still go in the log.** Store them as `model` rows, for example the existing `email_interpretation` kind (`packages/contracts/src/user-model.ts:63`). This follows Fowler's gateway rule: the log remembers the answer of the external query, so a replay gives the same result (section 1.10). The projection reads them as context, never as evidence.

**Fix the defaults.** Remove the `{"kind":"agent"}` default on `user_facts.source` and `memory_chunks.source` (`packages/db/src/schema/memory.ts:58`, `:286`). Each writer must name its actor. Stop the sender prior that counts the model's label (`docs/theory/README.md:56`).

**Trade-offs.**

- Zep lost 17.7% on questions about what the assistant said (section 1.5). Alfred keeps the chat transcript as recall, so the model can read what it said. The transcript is not evidence for a fact.
- With 0 user corrections in 1,512 triage rows (`docs/theory/README.md:56`), user-only evidence is sparse. Implicit acts (a reply, an archive, a merge) must count, or the memory learns nothing.
- Background extraction (LangMem, section 1.9) has higher recall. Under this rule it can only propose. It cannot confirm.

### 4.3 Answer to (c): provenance and time

**Use the ADR-0111 D2b contract. Do not design a new one.** It already matches Zep's four timestamps and Fowler's two axes:

| Zep (section 1.5) | Fowler (section 1.10) | Alfred field |
| ----------------- | --------------------- | ------------ |
| `t'created` | record time | `observations.createdAt`, as `recordedAt` |
| `t_valid`, `t_invalid` | actual time | `validFrom`, `validUntil` from the evidence |
| `t'expired` | a later record | a successor row (`supersedesObservationId`) |
| episode link | event log | `familyKey` plus citations on each statement |

**Rules.**

- **Never delete.** A change is a new event. A user delete is a reversal event (Young, section 1.10). Mem0 DELETE and A-MEM evolution are the anti-pattern.
- **Authority, then validity, then record time.** Zep lets new information win (section 1.5). Alfred must not. A user correction (rank 0) beats any later inference. A late import of an old mail does not replace newer evidence (ADR-0111 D2b, `:60`).
- **No invented valid time.** Remove the `defaultNow()` on `user_facts.validFrom` (`packages/db/src/schema/memory.ts:60`). An unknown start stays unknown (ADR-0111 D2b, `:58`).
- **Age is a read-time judgment.** Stored confidence never uses age. The reader applies currency at an explicit `asOf` (ADR-0111 D2b, `:64`). This keeps replay deterministic.
- **Each statement cites its events.** Generative Agents stores pointers to cited records (section 1.7). Zep keeps two-way links (section 1.5). Alfred statements cite observation ids.

**Trade-off.** Bi-temporal reads cost more SQL and more tokens. Zep reports that weaker models read the temporal data poorly (section 1.5). So the model-facing read must be short: a value, a status (`current`, `stale`, `unknown`, `conflicted`), and one date. Full history is a pull.

### 4.4 Answer to (d): push a small index, pull the content

**Push at run start (bounded, snapshotted per thread for the cache):**

- The self block, as today (`packages/assistant/src/chat/chat-turn.ts:206`).
- The user core: name, logins, org, and own repos. This is a Letta-style read-only block (section 1.4).
- A **referent index**: the top N referents by user acts, one line each, as lightweight identifiers (section 1.2). Example line: `repo 99Yash/alfred ("alfred"): 94 PRs authored, last act 2026-11-10 [ent_...]`. No content, only the name, kind, act count, last act, and id.
- The active standing instructions, in short form.

**Pull by tool:**

- `resolve(mention)` for any name that is not in the index, and for any ambiguous name.
- A referent read: state, live provider facts, statements with time, and recent user acts.
- `system.search_context` for content, only after a referent is fixed or when `resolve` returns NIL.

**Why this split.** MemGPT reports that models stop lookups early or skip them (section 1.4). A pushed index removes the lookup for the things that the user touches most. Anthropic keeps injected context small, because long instruction files lower adherence (section 1.1). The index costs about one line per referent. The long tail stays behind `resolve`.

**Trade-offs.**

- The index changes as the user acts. A change breaks the prompt cache. Snapshot it at the first turn of a thread, as `selfIdentity` already is (`packages/assistant/src/chat/chat-turn.ts:201`). A thread then sees a stale index for its life.
- N is a budget choice. Letta advises fewer than 20 blocks (section 1.4), and Claude Code caps its index at 200 lines (section 1.1). Start small, for example 30 lines, and measure.
- The Claude memory tool forces a first read by prompt (section 1.3). Alfred pushes the index instead, so no first tool call is needed.

---

## 5. Order of work, against the theory page

This model is a foundation for items 2 and 3 in `docs/theory/README.md:122-143`. It does not replace ADR-0111. It adds one primitive (resolve, with NIL) and one rule (actor on each observation).

1. Settle with the owner: the actor field, the surface-name identity kind, and the referent index in the chat prompt. This is theory work (`docs/theory/README.md:105`).
2. Activate the projection, and let GitHub write identities.
3. Land chat capture to the log (#399), with the actor field.
4. Add `resolve` and the referent index. Add the "Alfred's issues" trace as an eval case (principle 1).
5. Move statement reads to the ADR-0111 D2b time contract.

## Residual risks

- The salience prior is a count. A count can favor noise that the user acts on often, for example a bot repo. A user pin or a correction must override it.
- The OpenAI claims in section 1.9 are not verified.
- The 94-PR and 10,000-document numbers come from the owner's report. This note did not query production.
