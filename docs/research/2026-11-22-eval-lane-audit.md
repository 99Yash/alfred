# The eval lane audit (2026-11-22)

An audit of the eval lane against the product direction, run before ADR-0133. Method: a review agent read the theory pages, ADR-0055 and its amendments, the 12 `*.eval.ts` suites, the CI workflows, and the slice receipts, and graded coverage, scorer design, and CI posture. Findings are cited to files; commit refs are from the review date.

## Verdict

**Partly earning its keep.** The triage deck is high value — the only evidence-based gate in the repo, and it has changed whether slices ship three times. The other 10 of 12 suites are old regression nets, one-off decision tools, or nightly checks nobody acts on. The roadmap stages (journal, memory, loop closing, cold start) have no eval cases, and the lane's current shape could not grade them. Swapping the runner changes how results are viewed, not whether these gaps close.

## Inventory

There are 12 `*.eval.ts` files holding 17 `evalite(...)` blocks, on evalite `1.0.0-beta.16`. One judge factory serves them: `packages/assistant/evals/lib/llm-judge.ts`.

| Suite | Path | Call path | Scorers | Cases | Fixtures | Grade | CI |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **triage-deck** | `packages/assistant/evals/triage-deck.eval.ts` + `triage-deck/cases.ts` | Real `classifyEmail`, real `assembleObservations`, real `triageOutOfScope`, prod mail-facts reader, 21 prod instruction rows | Deterministic only: Coverage, Provider failures, Classify failures, Label, One label for the group | 30 cases, 66 mails, 3 trials | Mined from prod pulls 2026-11-06 and 11-16, redacted; 3 synthetic, marked so | One decision per mail; one cross-mail check | **Not in CI.** Run by hand per slice |
| **triage-classify** | `triage-classify.eval.ts` | Real `classifyEmail` | Deterministic + judge on the **same cheap model** as the classifier | 38 | Hand-written from the old rubric era; `NOW` pinned 2026-06-10 | One step | `triage-eval.yml` `--threshold 70`, manual dispatch only; last run 2026-10-30 |
| boss-judgment | `boss-judgment.eval.ts` | `generateText`, real chat prompt, hand-built tool surface, no `execute`, 3 steps | Deterministic tool-name checks | 3 + replay + depth + sub-agent | Synthetic | One step | Local |
| date-grounding | `date-grounding.eval.ts` | `generateText`, stops at the calendar `mcp.call` | Deterministic window overlap | 4 | Synthetic | One step | Nightly, `--threshold 0`; 100% on 11-21 |
| **sender-suppression-grounding** | `sender-suppression-grounding.eval.ts` | `generateText`, stubbed Gmail search, 3–4 steps | Deterministic | 3 + 3 | Synthetic | Up to 4 steps | Nightly, `--threshold 0`; scored 33–83% (11-13 → 11-21) while the job stays green |
| voice-ai-tells | `voice-ai-tells.eval.ts` | `generateText` on the chat prompt | Deterministic voice rules + judge on a different provider family | 7 × 2 | Synthetic | Single reply | Nightly, `--threshold 0`; 93–100% |
| time-awareness | `time-awareness.eval.ts` | `generateText`, production prompt + clock | Deterministic | 7 | Synthetic | Short trajectory | Local |
| code-mode-read | `code-mode-read.eval.ts` | Real `system.code_run` sandbox, fake host functions | Deterministic trajectory checks | 1 | Synthetic (41 issues) | **Trajectory + end state** | Local |
| code-mode-paired | `code-mode-paired.eval.ts` | **The production chat loop** against local Postgres and Redis; only the GitHub MCP client is fake | Deterministic: planted facts, finished, cost, tokens | 30 runs | Synthetic repo | **End state** | Local (one-off decision tool, receipt 2026-11-18) |
| tool-selection-bloat | `tool-selection-bloat.eval.ts` | `generateText`, first tool call | Deterministic | 5 × 2 menus | Synthetic | One step | Local (experiment) |
| briefing-notification-reminder | `apps/server/evals/briefing-notification-reminder.eval.ts` | Real briefing prompt, stub tools, stops at `dump_briefing` | **17-pattern regex** over prose | Machine cases × 2 lanes + 1 | Synthetic | Single compose | `scoreThreshold: 100`, but no workflow runs it |
| briefing-out-of-scope-mail | `apps/server/evals/briefing-out-of-scope-mail.eval.ts` | Same harness | Regex | 2 | From deck cases | Single compose | Local |

The real gate for prompt and model changes is the paired prod replay, `apps/server/src/scripts/dry-runs/triage-prompt-replay.ts` (owner decision 2026-11-16).

## Strengths

1. **The deck is where "make the fault an eval case" is really done, and it changes decisions.** Built 2026-11-07, the day after the 11-06 prompt spiral (`863e60be5`). The chess.com 4-label mail, the nine sign-in echoes of 11-13, and the DeepInfra newsletter are cases. It **held slice 1** (chess 0.50 → 0.25, voyage 1 → 0), let slices 2–3 through with per-case evidence, and on 2026-11-22 **caught 4a regressing the worst-error case** (`sign-in-by-another-person-is-loud` 1 → 0), which also exposed a scorer bug fixed in the same slice.
2. **Designed for model noise.** 3 trials; provider weather scored apart from model faults; no verdict scores 0; `controlOf` separates "the instruction did it" from "the mail was quiet anyway"; `DECK_INSTRUCTIONS=none` is the A/B switch.
3. **Code Mode suites are the first end-state graders.** `code-mode-paired` runs the real production loop. Its receipt settled the default read path.
4. **Real model, real prompt, deterministic first.** The judge is used in only 2 suites.

## Weaknesses

1. **Coverage stops at triage labels and chat tool choice.** No cases for journal and recall, memory claims and the check job, loop closing and asks, the workflow class, cold start, or triage slices 4b–7. Theory pages promise cases that do not exist (`memory.md`, `journal.md`, `core-agent.md`'s "first eval case of the voice" — `voice-ai-tells` tests chat replies, not briefings).
2. **One-step grading is still mostly true.** Every `generateText` suite uses hand-built surfaces with no `execute`, caps steps at 3–4, and checks arguments. Only `code-mode-read` and `code-mode-paired` grade an end state, and neither runs regularly.
3. **Suites grade outdated behavior.** `sender-suppression-grounding` rewards the sender-list mechanism that `triage.md` rejects ("Alfred never converts a description into a list of senders") and that slice 4a removed; its falling score may be noise, drift, or the product moving away — nobody can tell, because nobody reads it. `triage-classify` is the only CI-wired suite and the wrong one: stale June-era cases, a judge on the same cheap model as the classifier (reverses ADR-0055's "stronger, different model" rule without an amendment).
4. **Nobody reads the results.** `grounding-evals.yml` went green 13 nights while sender-suppression sat at 33–58%. The briefing suites' `scoreThreshold: 100` gate has no workflow. One gate remains in practice: the owner running the deck by hand.
5. **The ADR-0055 tiers never happened.** Still the dev tier only. The regression tier's source (`rejected_inferences cause='user'`) is empty by construction — 0 user corrections in 1,512 triage rows — until slice 5 ships. No stored history: comparisons live in scratch logs and prose receipts.
6. **Briefing scorers are regex over prose** — principle 1's failure mode, relocated into the scorer. A reworded fabrication passes; a neutral reminder that matches fails.
7. **Synthetic fixtures dominate outside the deck**, and caused one false finding (the public-repo fixture the model answered from real data).
8. **Cases are owner-labelled and small**, and grow only when the owner spots a fault in production.

## Fit against the next six months

| Roadmap item | Can the lane grade it? | Why |
| --- | --- | --- |
| Triage 4b (named person) | Partly | The deck can grade the label; the `ask_user` → confirm → save flow needs a multi-turn harness (`code-mode-paired`'s approval path is a start) |
| Triage 4c (30-day re-triage) | **No** | Needs seeded DB state and a set-level scorer |
| Triage 4d (profile) | Indirectly | The deck could replay with a profile; grading the profile is not a single-call question |
| Triage 5 (Gmail correction) | **No** | Needs an event sequence: relabel, then a new mail on the thread |
| Triage 6 (gather) | Partly | Needs a fake-host-function harness driven from triage |
| Journal recall | **No** | Recall@k over an embedded corpus with labelled queries — no index, corpus, or ranking scorer |
| Journal back-test note count | **No** | An offline batch over production history; output is a number the theory sets |
| Memory check-job verdicts | Not yet | The planned route fits (Code Mode + fake hosts); fixtures and a labelled verdict set don't exist |
| Briefing closes a loop | **No** | The harness stops at `dump_briefing` and scores prose; not built anyway |
| Cold start | **No** | Nothing covers it; "first impression" needs a judge on a stronger model |

The lane is built to send one input through one call and score one output. Recall, back-tests, check-job verdicts, and loop closure need seeded multi-row state, event sequences over time, and set-level metrics — absent from the **design**, not the runner.

## Runner-bound vs design-bound

**A runner swap fixes:** no score history; no alerts on drops; hand-mined fixtures instead of "add a prod trace to a dataset"; terminal-only comparison; evalite-beta reporter brittleness (the "never throw" workarounds).

**A runner swap does not fix:** one-step `generateText` harnesses; suites grading rejected mechanisms; the same-model judge; regex scorers; no harness for seeded state, time sequences, or retrieval metrics; 0 user corrections; no habit of acting on non-gating results; promised cases that don't exist.

**The cost of any hosted swap** works against principle 7 (fewest moving parts) and touches ADR-0055's rejection of hosted platforms — the owner's call under principle 6. Langfuse itself is already the accepted vendor of ADR-0023, which removes the vendor half of that rejection.

## Highest-leverage improvement, whichever runner

Extend what made the deck work — mined from production, owner-labelled, deterministic, multi-trial, run before and after each slice — to the next foundation's own unit of work, **before** that foundation is built. Name and fixture the gate in the same slice. The first two: the memory check job's labelled verdict set (Code Mode program, fake hosts) and the journal's labelled recall set. In the same sweep, retire or rewrite suites that grade rejected mechanisms, starting with `sender-suppression-grounding`, so a falling score means something.
