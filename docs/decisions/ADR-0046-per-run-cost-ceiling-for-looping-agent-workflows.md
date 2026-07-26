# ADR-0046 — Per-run cost ceiling for looping agent workflows (stub, deferred)


**Status.** Stub. Surfaced during m13 Phase 7 grilling as a sibling concern to ADR-0035; deferred from m13 so compaction can ship without entangling budget enforcement. Decide and implement post-m13.

**Decision (intended).** Introduce a per-run USD budget cap for any workflow whose run is driven by an LLM loop (today: `userAuthoredBriefWorkflow`'s boss-turn ↔ dispatch-tools ↔ compact-transcript triplet). When the running sum of `api_call_log.cost_usd` for a `run_id` crosses the cap, the executor fails the run with `error.message='cost_ceiling_exceeded'` before the next `boss-turn`. Default cap to be sized against observed real-world runs; v1 likely a static config knob (`ALFRED_PER_RUN_USD_CEILING`) before becoming a per-workflow column.

**Why this is its own ADR.**

- **Orthogonal to ADR-0035.** Compaction preserves *quality* by keeping the context window in the high-quality region. It does not bound *cost* — a runaway loop with cheap tool errors can compact happily and still rack up boss-turn calls. The 30-turn cap in `userAuthoredBriefWorkflow` is a structural ceiling but a coarse one (a single high-input turn can cost more than 30 small ones).
- **Orthogonal to ADR-0045.** ADR-0045 gates a *single document's* embedding cost; this gates a *single run's* total spend across LLM + tool calls.
- **Why not "in m13".** Designing the right surface (per-workflow override? user-level monthly cap? soft warn vs hard fail?) requires real run data Alfred doesn't have yet. Shipping compaction first lets us watch cost distributions accumulate in `api_call_log` and pick the threshold empirically rather than guess.

**Open questions to settle when this ADR lands.**

- Granularity: per-run only, or also per-workflow / per-user / monthly?
- Behavior on cross: hard-fail the run (current sketch) vs. interrupt for user approval to continue (HIL pattern) vs. soft-warn + log?
- Whether the cap reads from `model_prices` × estimated next-turn token count for *pre-flight* rejection (cheaper but inexact) or only post-hoc from `api_call_log` (exact but always burns the over-budget call).
- Whether to count compactor spend against the cap (compactor saves boss spend; double-counting punishes the right behavior).

**Cross-ref.** Sibling to ADR-0035 (quality). Builds on ADR-0015 (per-call cost log). Will likely interact with ADR-0034 if a "user approves continuing past budget" branch is added.
