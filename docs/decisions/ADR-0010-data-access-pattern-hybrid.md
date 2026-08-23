# ADR-0010 — Data access pattern: hybrid (ingest + live)

**Decision.** Per-integration policy split between background ingestion (writes into Postgres + pgvector, supports semantic search and morning-briefing reads) and live API calls (current state, low-staleness operations, posting actions).

**Per-integration starting policy:**

- **Gmail** — ingest body + headers + threads; live-poll the last 24hr for freshness; live-call to send.
- **Calendar** — live-only (small payload, must be fresh).
- **Docs** — ingest content; live-call to read a specific doc by ID.
- **Slack** — ingest opted-in channels; live-call to post.
- **Linear / GitHub** — live-only (small payloads, real-time status matters).
- **iMessage** — ingest only (no live API; sourced from local export).

**Why.**

- Live-only kills morning-briefing UX (each turn becomes 50 API calls; agent context blows up).
- Ingest-only breaks correctness (calendar must reflect a change made 5 min ago).
- Per-integration policy is natural and matches dimension's `warmIntegrationNamespaces` + live-RPC split.

**Alternatives.** Live-only (rejected — no semantic history, no offline reasoning). Ingest-everything (rejected — stale calendar within a week).

**Implementation shape.** `packages/integrations/<provider>/` exports `oauthFlow`, `liveTools`, `ingestor`, `webhookHandler`. `packages/ingestion/` holds shared chunker, embedder, dedup, vector-write helpers. One `documents` + `chunks` schema, source-tagged, vector column on chunks.
