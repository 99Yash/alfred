# ADR-0014 — Deploy safety: durable-resume with idempotent steps


**Decision.** Background agents and BullMQ workers use a durable-resume model. State persists to Postgres after each step. On graceful shutdown (SIGTERM), workers finish the current step (with timeout), mark inflight runs as `interrupted_at_checkpoint`, and exit. New version starts → polls for interrupted runs → resumes from last checkpoint. Every step is idempotent.

**Mechanisms required.**

- **Idempotency keys** per step: derived from `(run_id, step_id, attempt_id)`; passed to LLM/Gmail/Slack/etc; providers dedupe.
- **Action staging for outbound effects**: don't `slack.postMessage` inside a step; _plan_ a `SlackPost` row and commit the plan in the same tx. A separate worker reads pending plans and executes with idempotency.
- **Step boundaries chosen for durability**: a long token-streaming step is safe to lose and re-run; a multi-tool-plan step commits each tool plan as it goes.
- **Graceful shutdown** wired into the Railway service.

**Why.**

- Drain-and-deploy is unworkable when HIL means a run might pause for hours waiting for user approval; you'd never ship while anything's mid-task.
- Pinned-version workers (multi-version coexistence) require k8s/Nomad-style orchestration and backward-compat schemas — stratospheric overkill for one user.
- Idempotency is good design hygiene anyway: every external write needs an idempotency key for retries and crashes regardless. Durable-resume just makes it the default model.

**Alternatives.**

- Drain-and-deploy (rejected — blocks deploys behind in-flight HIL runs).
- Pinned versions (rejected — multi-version k8s overkill at this scale; concretely, a run paused on HIL for 3 days during a v1.4.2→v1.4.5 release cadence would force four parallel worker pools alive simultaneously, with backward-compat schema across all of them, and graveyard cleanup as permanent ops work).
