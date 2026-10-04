# ADR-0023 — Observability: Sentry + PostHog + Langfuse

**Decision.** Three tools, three lanes, all on free tiers:

- **Sentry** — server + browser exception tracking, perf, breadcrumbs. SDK in `apps/server` and `apps/web`; init via `instrumentation.ts` (milkpod has the pattern). Replicache mutators wrapped to surface mutator errors.
- **PostHog** — product analytics. Page views + custom events from key flows (workflow run started, skill invoked, fact accepted/rejected, draft accepted, integration connected). Useful even at single-user scale to track which workflows actually get used.
- **Langfuse** — LLM agent tracing. Cloud free tier (50K observations/mo); self-host on Railway as an option later if agent-prompt content needs to stay in our infra. Visualizes agent run trees: boss → sub-agents → tool calls, with prompt/response per node.

**Wire-up.** `metered()` (ADR-0015) emits a Langfuse span alongside the DB log row. Parent-child relationships via `run_id` / `step_id` / sub-agent ids. One module, two side effects per billable call.

**Why three tools, not one:**

- Sentry is best-in-class at JS errors and perf; weak at structured agent traces.
- Langfuse is best-in-class at agent run-trees; not for JS errors.
- PostHog is best-in-class at product analytics; not either of the above.
- Combined free-tier cost: $0 at personal scale.

**Why not LangSmith.** Tightly coupled to LangChain/LangGraph ecosystem; we rejected LangGraph (ADR-0006), so LangSmith integration would be manual and lose its value props.

**Why not Helicone.** Proxy-based logging is good for "list of all calls" but weaker for agent run-tree visualization. Once you have multi-step boss/sub-agent runs, the tree view is the primary debug surface.

**Why not Phoenix / Braintrust.** Both eval-focused; nice-to-have for prompt iteration but not the v1 observability lane. Could layer in later for systematic prompt eval.

## Amendment — JS/TS SDK v3 → v5 (2026-09-18, #1130)

**Decision.** Langfuse tracing moves from the v3 `langfuse` client to the
OpenTelemetry-based JS/TS SDK v5 (`@langfuse/tracing` + `@langfuse/otel`). The
observation surface in `packages/ai/src/metering/langfuse.ts` is unchanged in
shape — turn trace, generation, tool span, dispatch-rejection span, runtime
span — but it is built with `startObservation` / `propagateAttributes` instead
of `client.trace()` / `client.span()` / `client.generation()`.

**Why now.** Langfuse removed legacy ingestion and the deprecated read APIs on
2026-11-16. Production points at Langfuse Cloud, and v4 rejects JS/TS SDK v3 at
ingestion, so the SDK move is the remaining half of the v4 migration. The
self-hosted dev stack cuts over from `dual` to `events_only` write mode with
this change.

**What moved.**

- Trace identity: v5 has no trace upsert. A logical run id (`runId`, or the
  ad-hoc key) is hashed into a valid 32-hex OTel trace id and passed as
  `parentSpanContext`, so every observation of a run lands in one trace.
- Trace attributes: `userId` / `sessionId` / `tags` / `traceName` propagate with
  `propagateAttributes` (the v3 `client.trace()` payload).
- `release` / `environment`: now SDK config on `LangfuseSpanProcessor`
  (`LANGFUSE_RELEASE`, `LANGFUSE_TRACING_ENVIRONMENT`), not trace attributes.
- `public`: no call site sets it today; v5 exposes it as
  `setTraceAsPublic()` / `setActiveTraceAsPublic()`.
- Trace I/O: the root observation's input/output is the trace's; the explicit
  ad-hoc root mirror is gone.

**Isolation.** The tracer provider is set with `setLangfuseTracerProvider` on a
dedicated `BasicTracerProvider` rather than the process-global provider, so it
does not replace the OTel provider Sentry installs in
`apps/server/src/instrument.ts`. Provider isolation alone does not cover
attributes: `propagateAttributes` also writes to whatever OTel span is active,
which is Sentry's. Trace attributes are therefore applied from `ROOT_CONTEXT`,
so the Langfuse observation gets them (the `LangfuseSpanProcessor` reads them
from the span's parent context) while no active global span is stamped.

**Residual risk.** v5 applies smart default span filtering: spans not created by
Langfuse and without `gen_ai.*` attributes can stop exporting. Every observation
here is created through the Langfuse SDK, so it is exported, but a future
non-Langfuse OTel span would not be. Set `LANGFUSE_DEBUG=true` and compare a
trace tree when changing this module.

## Amendment — production perf tracing off by default (2026-10-04)

**Decision.** The Sentry lane narrows to exceptions in production.
`tracesSampleRate` was `0.1` there and is now `0`, and the number moves to
`SENTRY_TRACES_SAMPLE_RATE` so a performance question can still be chased on
purpose. A non-production box that opts in through `SENTRY_ENABLE_DEV` keeps
`tracesSampleRate: 1`.

**Why now.** The decision above priced all three tools at "Combined free-tier
cost: $0 at personal scale". That was right about the vendor invoices and silent
about ours. Measured on the running production service, the server was shipping
roughly 1 GB/day of envelopes to Sentry's Frankfurt ingest endpoint — about
$1.50/mo of Railway egress and ~33 GB/mo against the Sentry quota — while
reporting no errors at all. Nothing in the app was looping to cause it:
`tracesSampleRate: 0.1` samples a tenth of every transaction forever, and a
service that is merely idle still has transactions. The spend therefore scaled
with uptime rather than with usefulness, which is the opposite of what this ADR
is for, and it was the single largest billable egress line in the project.

**What did not change.** Everything the exceptions lane carries.
`SENTRY_DSN` is still read; `captureException` still fires on an uncaught error
and on the graceful-shutdown path (`apps/server/src/index.ts`); and the
`beforeSend` / `beforeBreadcrumb` hooks that ADR-0038 hangs on the shared
`SENSITIVE_LOG_PATHS` table still run on every event and breadcrumb.
`packages/logging/src/report.ts` still writes both sinks. Tracing was a sibling
of the exceptions lane, never a precondition for it, so switching it off removes
the latency view and nothing else — no error stops being reported and no alert
stops firing.

**Residual risk.** Production now emits no transactions, so a latency
regression will not surface in Sentry until someone sets
`SENTRY_TRACES_SAMPLE_RATE` and redeploys. Langfuse still carries the agent
run-trees, which is the trace surface this repo actually debugs against.
`autoSessionTracking` is left at the SDK default (on): its envelopes are orders
of magnitude smaller than transactions and were not measured as a cost driver,
so it stays until someone measures otherwise.

## Amendment — the cost was Redis spans, not idle transactions (2026-10-04)

**Correction to the amendment above.** It attributed ~1 GB/day to
`tracesSampleRate: 0.1` sampling "a tenth of every transaction forever" on a
service that "is merely idle still has transactions". The measured cause is
narrower and worse: `@sentry/node` v10 registers an OpenTelemetry
instrumentation set **by default**, and that set includes `instrumentRedis`.
Alfred's BullMQ workers idle by issuing `BZPOPMIN` blocking pops and `EVALSHA`
queue Lua, so every idle worker was generating spans.

Measured over one production day before the change, from Sentry's own span data:

| span.op                                           | count   | share  |
| ------------------------------------------------- | ------: | -----: |
| `db.redis`                                        | 279,530 | 99.8%  |
| `http.server`                                     | 50      | 0.02%  |
| `http.client`                                     | 80      | 0.03%  |
| `gen_ai.invoke_agent` + `gen_ai.generate_content` | 120     | 0.04%  |

Within `db.redis`: `redis-evalsha` 153,530 and `redis-bzpopmin` 125,480.
`apps/server/src/instrument.ts` passes no `integrations` option, so
`getPreloadMethods()` returns the entire preload list
(`@sentry/node` → `integrations/tracing/index.js`), which also covers
Postgres, Mongo, MySQL, Kafka, Express, Koa, Fastify and GraphQL — none of
which this app uses.

**Decision.** This amendment records the cause and adds a standing constraint on
`SENTRY_TRACES_SAMPLE_RATE`. No code change.

**The constraint.** Do not raise `SENTRY_TRACES_SAMPLE_RATE` above `0` in
production until the Redis instrumentation is genuinely excluded from the
process. The cause is instrument *registration*, not the sample rate: `0.1` → `0`
cut egress 84% by sampling almost everything away, and any non-zero value
re-admits the Redis spans in proportion. A variable that reads like a
latency-tuning knob is a ~$1.50/mo egress switch.

**What did not change.** `tracesSampleRate: 0` in production, and the exceptions
lane, exactly as the amendment above states. No instrumentation is actually
disabled — that work has not been done.

**Residual risk, and the open work.** Three things hold at
`tracesSampleRate: 0`:

1. The instrumented libraries are still patched, and spans are still created and
   then discarded at sampling time. This amendment removed the egress, not the
   work. Measured CPU on the idle service is 0.0–0.1%, so it is not urgent — but
   it is not zero, and "tracing is off" is not the same claim as "nothing is
   instrumented".
2. **The suppression mechanism is unverified.** The obvious levers do not work:
   against `@sentry/node` 10.74.0, both `integrations: ["http", "node-fetch"]`
   and `integrations: []` still produced `db.redis.connect` spans. Treat "pass an
   explicit integration list" as a hypothesis, not a fix.
3. Re-enabling cheap tracing is worth wanting — those ~250 `http.server` /
   `gen_ai.*` spans per day are the signal this ADR exists for, and they would
   cost a rounding error beside the Redis flood. It stays gated on establishing
   the suppression mechanism first.

**A note on the arithmetic, because this investigation produced two confident
wrong numbers before the right one.** Envelopes batch up to
`DEFAULT_TRANSPORT_BUFFER_SIZE = 64` items, so dividing a connection rate by
`tracesSampleRate` cannot yield a request rate — the factor is a function of
your own traffic. And `tracesSampleRate` does not gate errors, sessions, or
client reports, so "envelopes per minute" was never a sampled quantity to divide
in the first place. The number that did reconcile was the span count itself:
279,530 stored spans at a 0.1 sample implies ~2.8M spans/day, which at 64 items
per envelope is ~30 envelopes/min and ~800 MB/day — matching the independently
measured 25.4 envelopes/min and 0.96 GB/day.
