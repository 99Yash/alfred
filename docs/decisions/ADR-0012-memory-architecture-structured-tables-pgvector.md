# ADR-0012 — Memory architecture: structured tables + pgvector


**Decision.** Memory is a small set of opinionated tables in Postgres:

- `user_facts` — typed key/value with `confidence`, `source`, `status` (proposed/confirmed/rejected/superseded), `valid_from`/`valid_until`, `supersedes_id`.
- `user_preferences` — tone, response length, content filters, tool-default knobs.
- `style_profiles` — see ADR-0013.
- `entities` + `entity_relations` — lightweight in-DB graph (recursive CTEs for traversal at this scale).
- `memory_chunks` — pgvector for semantic recall over freeform conversation summaries.

**Why.**

- Single-user economics demolish Zep+Neo4j: graph DB ops cost for a graph that fits in 10MB.
- Most queries alfred needs are 80% structured key-lookup, 15% semantic recall, 5% multi-hop. Tables nail the first two.
- **Correction loop is trivial**: alfred infers a fact → row with `status='proposed'` → Replicache syncs → user accepts/rejects/edits → status changes. The full UX is just rows.
- **Provenance is first-class.** Each fact links to its source (`email_id`, `chat_message_id`, `tool_call_id`). User can ask "why do you think my manager is Alice?" and see the source.
- **Temporal facts** via `valid_from`/`valid_until` + `supersedes_id` (replicates Zep's temporal-edge feature in SQL).
- **Graceful upgrade**: if multi-hop ever matters at scale, swap `entities` + `entity_relations` for a real graph DB; interfaces don't change.

**Alternatives.**

- Zep + Neo4j (rejected — single-user economics, fuzzy correction model, weaker provenance).
- Vector-only with summary docs (rejected — "who is my manager" should be a row lookup, not a fuzzy similarity search).
