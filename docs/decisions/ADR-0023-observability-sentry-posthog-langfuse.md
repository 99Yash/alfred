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
