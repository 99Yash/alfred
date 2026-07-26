# ADR-0055 — Eval lane: local evalite, deterministic + LLM-judge scorers, dev tier now (CI/regression deferred)


**Decision.** Alfred's LLM call sites are guarded by **behavioral evals run locally with [evalite](https://evalite.dev)** — no eval service, no cost beyond the model calls themselves. Each eval runs the **real** call path (e.g. `classifyEmail`'s cheap-first→conditional-second→override-floor sequence) against the production model and scores the output with a mix of **deterministic scorers** (exact, free — category match, tool-name match, "did a todo mint," date-window arithmetic) and an **LLM-as-judge scorer** for the subjective dimensions a deterministic check can't see (is the *reasoning* sound and grounded in the email? is a todo title written the way a human would jot it?). The judge runs on a **stronger, different model** than the system under test (Sonnet judging Gemini Flash-Lite) to avoid self-preference, and returns a **letter grade (A/B/C/D)** against an explicit rubric — LLMs grade letters far more consistently than 0–100 — mapped to a number in code, with its explanation surfaced per-case. This is the lane the triage rubric (ADR-0051/0059), the date-grounding guard (ADR-0053), and Loop-2 memory corrections (ADR-0056) are all validated against. Files live in `packages/api/evals/`; run with `pnpm --filter @alfred/api eval`.

**Micro-decisions.**

1. **evalite, local-only — buy nothing, add no service.** Evals are dev-loop tooling, not a hosted product surface. evalite runs from the repo (`eval` / `eval:watch` + a local UI on :3006), reads keys from `apps/server/.env`, and costs only the underlying model calls. No Braintrust/LangSmith dependency, consistent with the single-user, substrate-frozen posture elsewhere.

2. **Score the real path, not a re-implementation.** The eval calls the same exported functions production does (`classifyEmail`, `resolveTodoSuggestion`, `todoSuppressionReason`, the structural suppression guard) so a passing eval reflects the shipped decision, not a parallel mock. "Now" is pinned (`NOW`) so relative-date resolution is stable across runs.

3. **Deterministic where checkable, LLM-judge only for the subjective.** Deterministic scorers are the hard signal and are preferred wherever the answer is verifiable in code. The judge is reserved for reasoning soundness and human-likeness — graded by letter, on a stronger model, and required to explain itself.

4. **Tier model: dev today; CI + regression deferred.** The target is **dev** (5–10 hardest/current-priority cases, every local change) → **CI** (recent dev + golden, every commit, < ~15 min) → **regression** (everything, scheduled). Today **everything is the dev tier**: small, hand-authored, deliberately adversarial (the boundaries, not the easy middle). The triage dataset is seeded from golden positives + the **documented real misses** the classifier prompt's own exemplars were written against (Sakshi-ownership, the ClickUp bot-"Done" burying a live assignment, the LinkedIn senior-IC nicety, the pre-merge PR advisory, the freemium upsell). Any coverage cap is `log()`'d so "N cases" never reads as "fully covered."

5. **Regression tier is seeded from real corrections — when Loop-2 is wired.** ADR-0056's user-correction loop lands overrides in `rejected_inferences` with a `cause` + rationale; the `cause='user'` rows are exactly the labeled misses an eval wants. When that write path ships (Loop-2, `docs/plans/long-term-memory-v1.md` P6), an exporter maps those rows to `Case` fixtures and feeds them as the regression tier. Until then the dataset stays hand-authored. This is the consumer side of ADR-0056 micro-decision 8 ("Loop 2 feeds the eval lane, never auto-tunes").

6. **Evals gate humans, never auto-tune.** No prompt or rubric mutates from eval output — the lane informs a human who edits prompts deliberately (consistent with ADR-0050/0051's "principles over exemplars, tuned from logs"). The eval is a regression net and a design check, not a training loop.

**What this builds on / feeds.**

- **ADR-0051 / ADR-0059** — the triage rubric whose category + todo-mint decisions this lane regression-tests; the ADR-0059 directional-significance cases are the over-correction guardrail.
- **ADR-0053** — the date-grounding behavior `date-grounding.eval.ts` guards.
- **ADR-0056** — supplies the regression-tier dataset (`rejected_inferences`, `cause='user'`) once Loop-2 lands; this ADR is its eval consumer.
- **ADR-0011 / ADR-0022** — the model dispatchers + cost posture the evals exercise the production tiers of.

**Alternatives.**

- (a) **Hosted eval platform (Braintrust/LangSmith).** Rejected: a second vendor + data egress for a single-user dev loop where local evalite covers the need at zero marginal infra.
- (b) **Pure deterministic, no LLM judge.** Rejected: category/todo correctness is checkable in code, but rationale soundness and todo-title human-likeness are not — those are exactly where the classifier silently degrades, so a judged dimension earns its keep.
- (c) **Auto-tune prompts from eval/correction signal.** Rejected (see micro-decision 6): humans gate prompt changes; automatic tuning risks overfitting to a tiny adversarial dataset and erasing the principle-driven rubric.

**Open (settle from runs, not now).**

- Exact dev→CI promotion bar, the CI time budget, the regression-tier exporter shape, and when a second judge model is worth the cost.
