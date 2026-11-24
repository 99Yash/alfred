# Evals (ADR-0055)

Behavioral evals for Alfred's LLM call sites. We run [evalite](https://evalite.dev)
locally — no extra service, no cost beyond the model calls themselves.

```bash
pnpm --filter @alfred/assistant eval        # run once
pnpm --filter @alfred/assistant eval:watch  # watch mode + local UI on :3006
```

A bare `evalite run` globs **all nine** suites in this directory, `boss-judgment`
and `code-mode-paired` included. Every suite calls a real model, so a bare run
costs real tokens. Name one suite to run one:
`pnpm --filter @alfred/assistant exec evalite run date-grounding`.

Env (loaded from `apps/server/.env`): the three Cloudflare AI Gateway vars
(`CLOUDFLARE_AI_GATEWAY_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_GATEWAY_ID`).
Every model call goes through the gateway, so there are no provider keys to set.

- `route("cheap")` (Gemini Flash-Lite) is the triage classifier under test in
  `triage-deck`, and the DEFAULT LLM judge. `voice-ai-tells` calls
  `llmJudgeScorer` with the cheap default. `chat-recall` passes `route("boss")`
  for its case-A judge. The other suites score deterministically and need no judge.
- `route("standard")` (Haiku 5.5) — eight suites GENERATE on that route, because
  the system under test there is the chat agent itself: `boss-judgment`,
  `chat-recall`, `code-mode-paired`, `code-mode-read`, `date-grounding`, `time-awareness`,
  `tool-selection-bloat` and `voice-ai-tells`. No suite JUDGES on that route now.
  The ADR-0074 passthrough honesty suite was the only one, and it graded the
  `github.request` tool, which ADR-0125 removed.

The default judge model lives in ONE place, `lib/llm-judge.ts`. A suite that
needs a stronger grader passes `model` to `llmJudgeScorer`; nothing else states
it.

## Files

- `date-grounding.eval.ts` — chat agent resolves relative/partial dates instead
  of bouncing them back (the ADR-0053/0055 regression guard). It reads the
  calendar through the Google Calendar MCP server. Deterministic only.
- `time-awareness.eval.ts` — ADR-0130 decision 7 (owner decision 2026-11-21: no `<sent>`
  stamp). A message gets a time note only at the first message, after the pause, or on a new
  date, so the model must look up the time when the answer needs it. Six cases: a question 28 min
  after the last message (direct and Code Mode), the same question hours later with a note, a
  40 min export that moves "now" inside the run, and a control question that needs no time. The
  prompt, the time note, and the clock (in the kernel) are the production ones. The run does
  not add the `[system]` note of a long step, so case (d) measures the path with no note. Two
  scores: the answer (event, direction, wait within 5 min), and the lookup. A lookup that the
  answer does not need is a cost metric, not a fault. Deterministic only.
- `chat-recall.eval.ts` — the journal eval gate (ADR-0133; `docs/theory/journal.md` section 3).
  Case B: a past talk exists, and the reply names it with its date, with no tool step. Case A:
  no past talk exists, and the reply does not invent one (journal.md section 1, worst error 2).
  Each case has plausible distractors in the recall. Each case runs with no recall (the code
  before chat-time recall) and with the production `<recalled_chats>` block. B is
  deterministic. A uses `llmJudgeScorer` on `route("boss")`, a stronger family than the Haiku
  chat model.
- `boss-judgment.eval.ts` — chat boss source-ladder judgment: repeated "more"
  asks and public/current questions must reach web/sub-agent breadth, while
  calendar requests must not over-search.
- `voice-ai-tells.eval.ts` — a small, non-gating sample that checks
  Alfred's default chat voice for high-confidence AI-writing tells and grades
  usefulness with a cheap cross-provider judge.
- `triage-deck.eval.ts` — the ADR-0121 eval deck: real production mail, scored against
  `docs/theory/triage.md`. Each triage slice runs it before and after, and lands only when
  no case gets worse. Deterministic only.
- `code-mode-read.eval.ts` — the ADR-0124 driver run `run_s7yi1ymxakcj` in a `code_run`
  chat: every read must run in `system.code_run`, in few steps and a small context. The
  scripts run in the real sandbox against fake host functions (#898), so the trajectory is
  graded offline. Deterministic only.
- `code-mode-paired.eval.ts` — the ADR-0124 paired evaluation that decides the default read
  path. Each case runs in both read modes, three times each, through the production chat
  loop (`startChatTurn`, then `runOnce`). Only the GitHub MCP server is fake, at its
  protocol client. Needs the local Postgres and Redis, and no dev server. It writes the
  verdict of the owner's rule to `references/scratch/code-mode-paired/`. Deterministic only.
  `CODE_MODE_PAIRED_MODEL` sets the chat model for the whole run: `luna` (the default, the
  product route), `haiku` (`claude-haiku-5-5` at the chat route's reasoning level), or
  `sol61` (`gpt-6.1-sol` at reasoning `medium`; the gateway refuses `gpt-6.2-sol`). The report names the model in its title
  and in its file name. Each run records its total cost in USD and its largest call input.
  Tokenizers differ, so compare two models by cost, not by tokens. The verdict always
  compares the two read modes on one model.
- `tool-selection-bloat.eval.ts` — the context-purity experiment: does a bloated
  tool menu degrade tool selection? Runs the same tasks under a lean menu and a
  full one.
- `lib/github-repo-fixture.ts` — the synthetic GitHub repo and the fake GitHub MCP
  protocol client behind the captured catalog (`fixtures/github-mcp-catalog.json`).
- `lib/grounding.ts` — the `GroundingTaskOutput` shape the grounding suites share.
- `lib/time-answer.ts` — the scores of an answer that depends on the current time.
- `lib/llm-judge.ts` — reusable LLM-as-a-judge scorer factory.
- `lib/triage-classify-retry.ts` — the provider-weather guards of the triage deck.

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
  explanation surfaces in the evalite per-case panel. The judge runs on a
  stronger, different model than the system under test (ADR-0055, ADR-0133
  decision 3): a judge on the same model is a fault. See `lib/llm-judge.ts`.

## Dataset tiers

The eval-tier model (dev / CI / regression) we're working toward:

| Tier           | Size   | Cadence            | Contents                                             |
| -------------- | ------ | ------------------ | ---------------------------------------------------- |
| **Dev**        | 5–10   | every local change | hardest / current-priority cases — what's here today |
| **CI**         | medium | every commit       | recent dev cases + golden cases; < ~15 min           |
| **Regression** | large  | scheduled          | everything, tracked over time                        |

Today everything is the **dev** tier: small, owner-labelled, weighted toward the
hardest cases. The triage deck is mined from production mail and redacted
(`triage-deck/cases.ts`). Coverage is deliberately adversarial, not uniform — the
point is the boundaries, not the easy middle.

No CI workflow runs an eval (ADR-0133 decision 5). The gate is the owner running
the deck before and after each slice.

## Seeding from real corrections (deferred)

ADR-0055's intended regression-tier source is the user-correction loop: when the
user overrides Alfred's classification, the override lands in `rejected_inferences`
(ADR-0056) with a `cause` and a short rationale. The `cause='user'` rows are
exactly the labeled misses an eval wants. When that write path is wired (Loop-2,
`docs/plans/long-term-memory-v1.md` P6), add an exporter that maps those rows to
`Case` fixtures and feeds them in as the regression tier. Until then this stays
hand-authored — and `log()` any cap so "10 cases" never reads as "fully covered."
