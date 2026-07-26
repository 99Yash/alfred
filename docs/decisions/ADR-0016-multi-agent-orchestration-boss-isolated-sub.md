# ADR-0016 — Multi-agent orchestration: boss + isolated sub-agents + boss-only-writes run-context


**Decision.** Boss/sub-agent topology with a **namespaced scratchpad**: sub-agents auto-write to their own `scratch.{sub_id}.*` zone (no extra LLM cost; runtime persists the return value), boss reads scratch and promotes selected entries to `shared.*` (canonical/validated). Concretely:

- Boss agent plans, decomposes a task, spawns N sub-agents (parallel or serial), aggregates results, replies.
- Sub-agents return a structured summary; the **dispatcher auto-writes that summary to `scratch.{sub_id}.summary`** (and any sub-keys the sub-agent emits) — no extra LLM call to "write."
- Sub-agents can **read** from both `scratch.*` and `shared.*` via brief snapshot, but can only **write** to their own `scratch.{sub_id}` zone (enforced at the dispatcher layer, not by the model).
- Boss reads scratch and either: (a) cheaply promotes via a `promote(scratch_key)` tool call — no content rewrite — or (b) does a synthesis pass that condenses multiple scratch entries into a unified `shared.*` entry. Promotion is the moment of validation.
- Hard limits: max 1 level of nesting (no sub-sub-agents), max 5 parallel sub-agents per spawn batch (tunable), per-sub-agent step + token caps. Hitting a limit returns a partial result + reason.
- HIL interrupts (ADR-0006/0014) work at any agent level; durable-resume picks up the paused run.

**Schema.**

```
agent_run_context
  run_id
  key             text     -- e.g. 'shared.user_facts', 'shared.entities.alice', 'scratch.sub_a.summary', 'scratch.sub_a.findings.x'
  value           jsonb
  zone            enum(shared, scratch)
  written_by      text     -- 'boss' for shared.*, '{sub_id}' for scratch.{sub_id}.*
  written_at      timestamp

  primary key (run_id, key)
```

Per-run, TTL ~7 days (post-completion) for audit/replay. Lives in Postgres next to run checkpoints; no Redis needed for this surface.

**Why namespaced scratchpad vs boss-only-writes vs free-form:**

- **vs boss-only-writes**: avoids paying expensive-model cost just to retype sub-agent outputs (the original critique). Sub-agents already produced summaries; runtime persists them for free.
- **vs free-form sub-agent writes anywhere**: namespace scoping prevents one sub-agent overwriting another's findings or corrupting canonical state.
- **Compound-error risk**: a downstream sub-agent reading `scratch.*` knows it's unvalidated and prompts treat it as advisory; `shared.*` is authoritative; boss is the gate that validates before promoting. Same correctness property, different cost shape.
- Still gets the dedup + cross-pollination wins: boss promotes finding from sub-agent A and spawns B/C/D that read `shared.alice = manager` directly.

**Why no Redis for this layer:** at single-user scale, Postgres handles per-run K/V trivially; it's already the home of checkpoints, outbox, and run state. Redis stays for BullMQ + Pub/Sub.

**Why max 1 level deep:** unbounded depth is unbounded cost + latency + debugging hell; tasks decompose to 1 level 95% of the time; if a sub-agent thinks it needs sub-sub-agents, that's a sign for the boss to re-plan.

**Model defaults (subject to prompt-engineering pass).**

- **Boss**: Sonnet 4.6 default; escalate to Opus 4.7 via explicit `escalate_model` tool, or auto-escalate on a complexity heuristic.
- **Sub-agent reasoning**: Sonnet 4.6.
- **Sub-agent extract/summarize/classify**: Haiku 4.5 or Gemini 2.5 Flash; dispatcher picks cheapest available based on capability tags + credentials.
- **Long-thread compaction**: cheap tier (Haiku 4.5 / Gemini 2.5 Flash).

**Capability tagging, not hardcoded models.** Each sub-agent kind specifies required capabilities (`{ minContextWindow, supportsToolCalls, costTier }`), dispatcher resolves to a concrete model from `model_prices` + credential availability. Anthropic + Google initially; OpenAI when keys are available; dispatcher silently skips unavailable providers.

**Source for model registry / pricing seed.** `models.dev` provides public model pricing + capabilities; `pnpm --filter @alfred/db db:sync-prices` pulls + upserts into `model_prices` with today's `valid_from`.

**Alternatives.**

- (a) Single agent (rejected — context-window economics; 200K-token bloat from irrelevant tool results).
- (b1) Strictly isolated sub-agents with no shared context (rejected — forces serialized dependencies or duplicate-brief context).
- (b2-free-form) Free-form sub-agent-writes scratchpad with no scoping (rejected — race conditions, compound-error risk).
- (b-boss-only-writes) Boss-only-writes shared context (rejected — pays expensive-model cost to retype sub-agent outputs that the cheap sub-agent already produced).
- (b3) Direct inter-agent messaging (rejected — emergent coordination, hard to debug).
- (c) Hierarchical (rejected — unbounded depth/cost/latency; re-plan is the right primitive).
- (d) Workflow-graph only (rejected — loses the agent's value of choosing what to do at runtime; see ADR-0017 for how deterministic workflows still fit).
- (e) Actor model (rejected — cron + skills cover the persistent-agent pattern at our scale).

**Amendment (2026-05-22) — store layer moved to Redis (ADR-0036).**

The "no Redis for this layer" line is superseded. Live scratchpad reads/writes now go to Redis during a run; the executor's terminal step writes a per-key snapshot to `agent_run_context` for durable audit/replay. The rest of this ADR's pattern (namespaced scratchpad, boss-promotes-to-shared, single-writer-per-zone, 1-level depth cap, sub-agents don't compact) is unchanged. See ADR-0036 for the durability composition and crash-resume story.
