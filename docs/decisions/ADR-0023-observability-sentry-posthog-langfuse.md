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
