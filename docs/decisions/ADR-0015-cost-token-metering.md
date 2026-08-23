# ADR-0015 — Cost / token metering

**Decision.** Every billable external call (LLM, embedding, web search, transcription, tool-API) flows through a single `metered<T>(meta, () => Promise<T>): Promise<T>` helper. The helper writes a row to a flat `api_call_log` and computes `cost_usd` from a DB-backed `model_prices` table at write-time (snapshot, not recomputed retroactively). Aggregates (`cost_per_message`, `cost_per_run`, `cost_per_day`, `cost_per_skill`) come from materialized views or scheduled rollups, not pre-aggregated counters.

**Schema sketch.**

```
api_call_log
  id, created_at
  kind                enum(llm, embedding, web_search, transcription, tool_api, ...)
  provider, model
  input_tokens, output_tokens, cached_input_tokens
  cost_usd            numeric(12,8)   -- snapshot computed at write time
  latency_ms
  run_id, step_id, message_id, user_id   -- attribution chain (nullable)
  request_meta        jsonb           -- trimmed model params + attempt count
  response_meta       jsonb           -- finish_reason, usage, tool_calls count
  error               jsonb?

model_prices
  provider, model, valid_from, input_per_mtok, output_per_mtok, cached_input_per_mtok
```

**Implementation invariants ("pristinely").**

- **Single chokepoint** — all priced external calls go through `metered()`. Greppable for `metered(`. No bypass paths.
- **Async-safe** — logging never blocks the main path. Inline write on a separate connection (or bounded buffer + flush worker if Postgres ever struggles).
- **Failure-recording** — failed calls write rows too, with `error` populated and `cost_usd = 0` (or the partial cost if a stream consumed tokens before failing).
- **No double-counting** — one row per terminal success. SDK-internal retries are folded; attempt count goes in `request_meta`.
- **Strongly typed** — `metered<T>` preserves inner return type fully. No `any`.
- **Thin** — pure observation; no business logic, no payload transformation.
- **Idempotency-aware** — replays of the same `(run_id, step_id, attempt_id)` after crash recompute from SDK-cached responses; one row per successful unique attempt.

**Why flat log + rollups, not pre-aggregated counters.**

- Audit any single call without losing detail.
- Derive new aggregates later (per-skill, per-tool, per-integration) without schema migration.
- Postgres handles rollups trivially via materialized views or BullMQ-driven refresh.

**Why DB-backed `model_prices` with `valid_from`.**

- Price changes happen between deploys; price-table-as-code forces redeploy ceremony.
- Snapshotting `cost_usd` at write time means later price corrections never silently rewrite history.

**Alternatives.**

- Provider-wrapping (`meteredAnthropic = wrap(anthropic)`) — rejected; misses non-LLM costs (embeddings, search, transcription).
- OpenTelemetry spans + usage exporter — rejected for now; overkill, harder for in-app cost UIs. Could be layered on later for traces/latency without changing this design.
- Static TS price map — rejected; redeploy churn for a number that changes outside our release cadence.
