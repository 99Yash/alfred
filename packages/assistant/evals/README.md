# Evals (ADR-0055)

Behavioral evals for Alfred's LLM call sites. We run [evalite](https://evalite.dev)
locally — no extra service, no cost beyond the model calls themselves.

```bash
pnpm --filter @alfred/assistant eval        # run once
pnpm --filter @alfred/assistant eval:watch  # watch mode + local UI on :3006
```

A bare `evalite run` globs **all eight** suites in this directory, `boss-judgment`
and `triage-classify` included. Every suite calls a real model, so a bare run
costs real tokens. Name one suite to run one:
`pnpm --filter @alfred/assistant exec evalite run date-grounding`.

Env (loaded from `apps/server/.env`): the three Cloudflare AI Gateway vars
(`CLOUDFLARE_AI_GATEWAY_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_GATEWAY_ID`).
Every model call goes through the gateway, so there are no provider keys to set.

- `route("cheap")` (Gemini Flash-Lite) is the cheap classifier under test, and the
  DEFAULT LLM judge. It covers `triage-classify` end to end. Only two suites call
  `llmJudgeScorer` at all: `triage-classify` and `voice-ai-tells`. Both take the
  cheap default. The other suites score deterministically and need no judge.
- `route("standard")` (`gpt-6-luna`) — six suites GENERATE on that route, because
  the system under test there is the chat agent itself: `boss-judgment`,
  `calendar-grounding`, `date-grounding`, `sender-suppression-grounding`,
  `tool-selection-bloat` and `voice-ai-tells`. No suite JUDGES on that route now.
  The ADR-0074 passthrough honesty suite was the only one, and it graded the
  `github.request` tool, which ADR-0125 removed.

The default judge model lives in ONE place, `lib/llm-judge.ts`. A suite that
needs a stronger grader passes `model` to `llmJudgeScorer`; nothing else states
it.

## Files

- `date-grounding.eval.ts` — chat agent resolves relative/partial dates instead
  of bouncing them back (the ADR-0053/0055 regression guard). Deterministic only.
- `boss-judgment.eval.ts` — chat boss source-ladder judgment: repeated "more"
  asks and public/current questions must reach web/sub-agent breadth, while
  calendar requests must not over-search.
- `calendar-grounding.eval.ts` — chat agent answers relative calendar questions
  ("today", "this week") through the structured `window` / `partOfDay` fields
  instead of inventing a param name or hand-computing RFC3339 bounds.
- `sender-suppression-grounding.eval.ts` — chat agent searches Gmail before
  sender-suppression writes, and only persists a resolved sender when search
  hits clearly identify one address.
- `voice-ai-tells.eval.ts` — a small, non-gating nightly sample that checks
  Alfred's default chat voice for high-confidence AI-writing tells and grades
  usefulness with a cheap cross-provider judge.
- `triage-classify.eval.ts` — the email-triage classifier: category match, rail-todo
  mint decision, and an LLM-judge pass on rationale soundness.
- `triage-deck.eval.ts` — the ADR-0121 eval deck: real production mail, scored against
  `docs/theory/triage.md`. Each triage slice runs it before and after, and lands only when
  no case gets worse. Deterministic only.
- `tool-selection-bloat.eval.ts` — the context-purity experiment: does a bloated
  tool menu degrade tool selection? Runs the same tasks under a lean menu and a
  full one.
- `lib/grounding.ts` — the `GroundingTaskOutput` shape the grounding suites share.
- `lib/llm-judge.ts` — reusable LLM-as-a-judge scorer factory.
- `lib/triage-classify-retry.ts` — the provider-weather guards the two triage suites share.

## Scorers

Two kinds, both used:

- **Deterministic** — exact, fast, free. Tool-name match, category match, window
  arithmetic, "did a todo mint." Prefer these wherever the answer is checkable in
  code; they're the hard signal.
- **LLM-as-judge** (`lib/llm-judge.ts`) — for the subjective dimensions a
  deterministic check can't see (is the _reasoning_ sound? is a todo title written
  the way a human would jot it?). The judge returns a LETTER grade (A/B/C/D)
  against an explicit rubric, mapped to a number in code — LLMs grade letters far
  more consistently than they grade 0–100 — and must explain itself; the
  explanation surfaces in the evalite per-case panel. The judge model is a
  per-suite choice, not one rule: a stronger, different-family judge is the
  textbook defence against self-preference, and a suite whose judge is the only
  thing grading the claim pays for it. `triage-classify` does the opposite on purpose — it judges on `route("cheap")`, the classifier's own
  route, because its three deterministic scorers carry the proof and the judge is
  a readability signal. See `lib/llm-judge.ts` for the trade.

## Dataset tiers

The eval-tier model (dev / CI / regression) we're working toward:

| Tier           | Size   | Cadence            | Contents                                             |
| -------------- | ------ | ------------------ | ---------------------------------------------------- |
| **Dev**        | 5–10   | every local change | hardest / current-priority cases — what's here today |
| **CI**         | medium | every commit       | recent dev cases + golden cases; < ~15 min           |
| **Regression** | large  | scheduled          | everything, tracked over time                        |

Today everything is the **dev** tier: small, hand-authored, weighted toward the
hardest cases. The triage dataset is seeded from golden positives + the
**documented real misses** the classifier prompt's own exemplars were written
against (the Sakshi-ownership bug, the ClickUp bot-"Done" burying a live
assignment, the LinkedIn senior-IC nicety, pre-merge PR advisory, the freemium
upsell). Coverage is deliberately adversarial, not uniform — the point is the
boundaries, not the easy middle.

## Seeding from real corrections (deferred)

ADR-0055's intended regression-tier source is the user-correction loop: when the
user overrides Alfred's classification, the override lands in `rejected_inferences`
(ADR-0056) with a `cause` and a short rationale. The `cause='user'` rows are
exactly the labeled misses an eval wants. When that write path is wired (Loop-2,
`docs/plans/long-term-memory-v1.md` P6), add an exporter that maps those rows to
`Case` fixtures and feeds them in as the regression tier. Until then this stays
hand-authored — and `log()` any cap so "10 cases" never reads as "fully covered."
