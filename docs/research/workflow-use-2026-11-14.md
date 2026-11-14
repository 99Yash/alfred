# workflow-use: deterministic replay, and what it means for Alfred's spine

Status: research input, nothing settled. 2026-11-14. No runtime change. Repo facts are from the working tree on `main` at `c55c1625b`. The external project was read over the web only: no clone, no install, no run.

Read first: [trace-to-workflow-generation.md](./trace-to-workflow-generation.md) (the July study of the same project, at commit `fa53b3d`), [core-agent.md](../theory/core-agent.md) (the draft: one engine, determinism at the core), and [workflows-v1.md](../plans/workflows-v1.md) (the graduation ladder, just before "Implementation Seams").

The July page asked one question: can a trace become a reusable workflow (the Generate step)? This page asks a different one: **what does a deterministic replay tier cost and save at run time, and does it fit the spine that core-agent.md describes?** It does not repeat the July findings. It links to them.

## Sources

All external source links are pinned to `f00e27edd7f17600463ce37effa951f42ccb91c8`, the `main` HEAD on 2026-11-14 (last commit 2026-10-23).

| Source | URL |
| --- | --- |
| Repository and README | https://github.com/browser-use/workflow-use |
| Runner (`Workflow.run`, `run_with_no_ai`, fallback) | https://github.com/browser-use/workflow-use/blob/f00e27edd7f17600463ce37effa951f42ccb91c8/workflows/workflow_use/workflow/service.py |
| Format (step kinds, input schema, validators) | https://github.com/browser-use/workflow-use/blob/f00e27edd7f17600463ce37effa951f42ccb91c8/workflows/workflow_use/schema/views.py |
| No-AI executor | https://github.com/browser-use/workflow-use/blob/f00e27edd7f17600463ce37effa951f42ccb91c8/workflows/workflow_use/workflow/semantic_executor.py |
| Deterministic converter, cost table | https://github.com/browser-use/workflow-use/blob/f00e27edd7f17600463ce37effa951f42ccb91c8/workflows/docs/DETERMINISTIC.md |
| Variables | https://github.com/browser-use/workflow-use/blob/f00e27edd7f17600463ce37effa951f42ccb91c8/workflows/docs/VARIABLES.md |
| Maintainer statement, issue #84 | https://github.com/browser-use/workflow-use/issues/84 |
| Open community fixes, PRs #166, #168, #171 | https://github.com/browser-use/workflow-use/pulls |

## 0. Bottom line

- workflow-use is a **browser** record-and-replay tool. It turns one demonstration (by a person, or by one browser-use agent run) into a flat list of browser steps. A replay of the click, type, and navigate steps needs no model.
- **No run is free of a model, by its own rules.** The format requires that the last step is an `extract` step, and the extract step calls a model on each run. "No AI" means "no agent loop", not "no model call".
- **On deviation, it fails.** The agent fallback that the README describes is commented out at HEAD, the same as in July. There is no self-healing at run time. `HealingService` is the name of the generation service, not of a repair loop.
- **The project is not maintained for features.** A co-founder wrote on 2025-10-03 that "this repo itself is not going to be maintained -> the new version will most likely be built from scratch". After a burst of releases in November 2025, the commits are dependency and CVE bumps only. Open community PRs say that replay does not work on the pinned browser-use version. I did not run it to check.
- **For Alfred, the idea fits and the code does not.** The idea is "a stored program of typed steps, with model nodes marked in the artifact". It is the same as core-agent.md's "determinism at the core, non-determinism at the edges", and it is rung 3 of the workflows-v1 ladder. But no product job asks for it yet, and the most likely steps to replay are now MCP calls, which are Alfred's version of the DOM problem. Verdict in section 5: **adapt ideas, do not adopt**.

## 1. What workflow-use is

### Parts

- A Chrome extension that records clicks, typing, and navigation as events (`extension/`).
- A Python package `workflow_use` on top of browser-use (`pyproject.toml` pins `browser-use>=0.13.8,<0.14`). It holds the builder, the runner, the no-AI executor, a step verifier, and a file store.
- A CLI (`workflows/cli.py`, about 97 KB), a FastAPI backend, and a Vite UI that draws a workflow as a graph and runs it.
- An MCP service that publishes each stored workflow as an MCP tool, with a signature built from its `input_schema` (`workflow_use/mcp/service.py`).

### The format

A workflow is one YAML or JSON file (`schema/views.py`):

- Top level: `name`, `description`, `version`, `default_wait_time`, `steps[]`, `input_schema[]`, and an optional `workflow_analysis` (the model's notes from generation).
- `steps` is a **flat ordered list**. There are no edges, branches, loops, or conditions.
- Step kinds:
  - No model: `navigation`, `click`, `input`, `select_change`, `key_press`, `scroll`, `go_back`, `go_forward`.
  - Model: `extract` and `extract_page_content` (one model call over the page markdown), and `agent` (a full browser-use agent, bounded by `max_steps`).
- Each step can carry `output` (a context key for its result), `verification_checks`, `expected_outcome`, and `wait_time`.
- An element is found by `target_text` (the visible or accessible text), with `container_hint` and `position_hint` for repeats, and `selectorStrategies` as fallbacks. `cssSelector`, `xpath`, and `elementHash` are now marked "[LEGACY]".
- A validator, `validate_ends_with_extract`, rejects any workflow whose last step is not an extract step: "AI processing is always needed at the end of a workflow."

### How a workflow is made

Three paths:

1. **A person records it** with the extension. One model call then builds the step list (`builder/service.py`, `builder/prompts.py`).
2. **An agent records it** ("Generation Mode"): a person gives a task in words, browser-use does it one time, and the history becomes a workflow. Two converters exist:
   - The **LLM converter** (`healing/prompts/workflow_creation_prompt.md`): one structured-output call. The July page covers it in detail.
   - The **deterministic converter** (`healing/deterministic_converter.py`): a fixed map from agent actions to steps (`input_text` → `input`, `click_element` → `click`, and so on). It never emits an `agent` step. Then a validation call ("Validating workflow with AI...") and a variable pass run (`healing/service.py`, around lines 833–896).
3. **A person writes it** by hand. The examples folder has hand-written YAML.

### How a run stays deterministic

"Deterministic" here means "the runner does not ask a model which step to take next". It does not mean "the same input gives the same result":

- The step order is fixed, and the placeholders are filled from the inputs.
- `run_with_no_ai` sends each step to `SemanticWorkflowExecutor`. It finds an element by text with a ladder: exact, word, contains, then fuzzy (around `semantic_executor.py:1032`). A fuzzy match on a changed page can click the wrong thing and still report success.
- `run` (the default) tries the stored selectors, then the semantic executor if a step has `target_text` but no `cssSelector`.

### Variables

- `input_schema` declares each input as `{name, type: string | number | bool, format?, required?, default?}`.
- Steps use single-brace placeholders such as `{repo_name}`. The runner fills them with Python `str.format`.
- A step `output` key puts its result into the same context, so a later step can use it. This is the only data flow between steps. (The README roadmap still lists "take output from previous steps" as not done.)
- How variables are found at generation, and the "default to the recorded literal" rule, are in the [July page](./trace-to-workflow-generation.md#how-variables-are-induced--three-competing-mechanisms-none-authoritative). Nothing has changed since.
- `run_as_tool(prompt)` makes one model call to pull the input values out of a sentence (`workflow/service.py:1013–1036`).

### When reality differs from the recording

- A failed deterministic step raises `ValueError`. The log line still says "Attempting fallback with agent" (`workflow/service.py:671–675`).
- `_fallback_to_agent` is commented out (`workflow/service.py:421–493`). An `agent` step that fails raises "(Agent fallback is disabled)" (line 709).
- `run_with_no_ai` refuses any `agent` step before it runs (lines 1107–1109).
- `StepVerifier` (`workflow/step_verifier.py`) can check a step after it runs: deterministic checks first (URL, DOM), then an optional model check. It reports, and it does not repair.
- PR #171 (open, 2026-08-27) turns the fallback back on and fixes two bugs in it that "only surfaced once it actually executed". It is not merged.

So the honest answer is: **the run fails loudly when an element is not found, and it can pass wrongly when a fuzzy match finds the wrong element.** Nothing updates the stored workflow after a failure.

## 2. Where the tokens go

| Phase | Model use | How often |
| --- | --- | --- |
| Make (agent path) | One browser-use agent run (many calls), plus one conversion call (LLM converter) or none (deterministic converter), plus one validation call, plus a variable pass | One time per workflow |
| Make (recorder path) | One build call | One time per workflow |
| Run: navigate, click, type, select, key, scroll | None | Each run |
| Run: `extract` steps | One call each, over up to 50,000 characters of page markdown (`semantic_executor.py:2622`) | Each run (at least one, by the validator) |
| Run: `agent` steps | A full agent loop, `max_steps` (default 5 in the builder prompt) | Each run, if present |
| Run: `run_as_tool` | One call to parse the inputs | Each call |
| Run: `output_model` | One call to shape the results | Each run, if asked |

The project's own figures (`docs/DETERMINISTIC.md`): run cost "$0/run" with the deterministic converter against "$0.03–0.30/run" with agent steps, and make cost $0.01–0.05 against $0.10–0.30. They publish no success rate. The "$0/run" figure does not count the extract step that the validator requires.

**What makes a run cheap:** the steps that only move between known states (navigate, click, type) cost no tokens. The model reads only at the end, and only the page that the steps reached.

**The trade-offs:**

- **Brittleness.** The steps depend on a page that someone else owns. Text-first finding is better than CSS selectors, but a label change breaks a step, and a fuzzy match can pass wrongly.
- **Maintenance.** A broken workflow needs a new recording or a hand edit. There is no repair loop.
- **Capture cost.** The agent path pays for one full agent run, plus a review by a person of the variables (the CLI prompts for each one).
- **Engine drift.** The engine depends on the browser-use API. PR #168 says that browser-use 0.13 removed the Playwright calls that the engine uses, so that "any recorded workflow with a `cssSelector` step fails on its first element interaction", and that broad `except` blocks hide this. This is a third party's claim. I did not run it. The pinned range (`>=0.13.8,<0.14`) makes the claim plausible.

## 3. Maturity and health

| Fact | Value (2026-11-14) |
| --- | --- |
| Created | 2025-05-06 |
| Stars, forks | 4,253 stars, 354 forks (browser-use itself: about 121k) |
| License | AGPL-3.0 (browser-use itself is MIT) |
| Last release | v0.2.11, 2025-11-19. Ten releases v0.2.2–v0.2.11 between 2025-10-29 and 2025-11-19 |
| Last commit | 2026-10-23, a dependency CVE fix. All commits since 2025-11-19 are dependency, CVE, or README changes |
| Contributors | gregpr07 (co-founder, 92 commits), sauravpanda (46), then a long tail |
| Open issues and PRs | 76 open. Recent PRs are Dependabot bumps and unmerged community fixes (#166, #168, #171, #183) |
| Own warning | "very early development so we don't recommend using this in production" |
| Maintainer statement | gregpr07, issue #84, 2025-10-03: "this repo itself is not going to be maintained -> the new version will most likely be built from scratch" |

The relation to browser-use: workflow-use is a side project of the same company. It uses browser-use as its browser driver and its agent. The README says it was "born out of customer demand to make Browser Use more reliable and deterministic". The maintainer statement says the successor will be built into browser-use tasks, not here. The repo is kept safe (CVE bumps) but is not developed.

## 4. The Alfred mapping (ideas, not code)

### The job first (principle 6)

The mechanism is "store a program, replay it without an agent loop". The product job that it could serve is **lower token spend on repeated runs**, which the owner cares about. Today each run of an authored workflow is a full boss loop over the brief: the tick enqueues the run with `brief` (`packages/assistant/src/automation/tick.ts:171`), and the run is `user-authored-brief.ts`. So the spend is per run, and the replay idea addresses exactly that.

But the size of the job is not known. Nobody has measured how many authored workflows are active, how often they run, or what one run costs. The large spends that are known are the built-in loops (triage, briefing, chat), and two of them are judgment, which a replay cannot do. Before any design, the owner must say whether authored-workflow spend is a real cost. If it is not, this research stays a note.

### Where a replay tier would sit in the spine

core-agent.md says the spine is code (dedup keys, the gather, floors, loop verdicts) and the model is at the edges. workflow-use has the same shape in small form: fixed steps, and model nodes (`extract`, `agent`) that the artifact marks by kind. In Alfred terms:

- **A replay may only fetch facts. It must never replay a judgment.** Principle 4 says code owns only guarantees, and the model judges. A replayed "label this mail" or "is this worth telling the user" is a code verdict made once and frozen. A replayed "read these three sources" is the gather, and the gather is already code. So the honest line is: the stored program does the reads, and the model reads their results and decides. workflow-use's own validator says the same thing in its world: every workflow ends in a model step.
- **The built-in loops already do this.** The briefing gathers in code (`verifyLoops` at the gather) and then composes with the model. A replay tier adds nothing there. Its only new ground is authored workflows.
- This is rung 3 of the workflows-v1 ladder ("deterministic prefilter/reducer or outer graph with agent judgment nodes"). The ladder already says that compilation makes a new revision, shadows the interpreted one, and needs an evidence gate with "a measured cost/latency or risk win". This research adds nothing to that gate. It confirms it.

### Conflicts with settled decisions

- **Immutable revisions.** No conflict. A stored program is a new `workflow_revisions` row beside the brief. workflow-use has no versions at all (one file, overwritten), so Alfred is already ahead here.
- **High-tier activation with approval.** No conflict, but one rule follows: a compiled revision changes how the work runs, so it needs its own approval card. It cannot inherit the approval of the brief that it came from. The destination stays fixed on the revision (core-agent.md section 3), so a replay cannot post anywhere new.
- **ADR-0125's MCP gate.** This is the real conflict, and it is wider than the activation bug:
  - The gate refuses `mcp` at activation, so a workflow with an `mcp.call` step cannot activate (ADR-0125 decision 6; `revisions.ts:224` skips `mcp` in the ceiling). The owner accepted the gap on 2026-11-13 "because the workflow surface will be rewritten".
  - Since ADR-0125 (GitHub) and ADR-0126 (Google Workspace), the reads that a replay would most likely store are MCP calls. **An MCP tool is Alfred's DOM.** Alfred does not own its schema. It can change on the remote server, and ADR-0125 already records a tool with no output schema (`pull_request_read`) and captured schemas that "can drift from the hosted ones". The July page's main argument for a typed-tool substrate ("`gmail.search` is `gmail.search`") holds for curated tools. It holds less for MCP tools, which are now the main read surface.
  - So a replay tier over MCP needs a schema pin per step (the descriptor hash at compile time) and a check before each run. If the descriptor changed, the run must not replay.

### Worth adopting (as ideas)

1. **Mark the kind of each step in the artifact.** Each step says if it is code or model. The run, the cost display, and the approval card can then read it. This is core-agent.md's split, made visible on the revision.
2. **Postconditions on the step** (`expected_outcome`, `verification_checks`), checked in code first. A failed check stops the replay.
3. **Fail loud, then fall back on purpose.** workflow-use fails by accident (its fallback is commented out). Alfred must choose. The obvious choice is: on any deviation, run the interpreted brief (the boss loop that runs today), and record that the replay did not hold. Nothing repairs the stored program in place, because revisions are immutable and the system must not learn from itself (principle 5).
4. **The recorded value as the default of each input** (already in the July page).
5. **A workflow as a typed tool**, with its signature from its inputs (`mcp/service.py`). The chat could call a saved workflow as one tool.

### Not worth adopting

- The code. It is AGPL-3.0, browser-only, Python, and not maintained.
- The DOM machinery (text matching, fuzzy ladder, selector fallbacks). Alfred has no browser surface.
- Fuzzy success. A step that "matched something" is not a verified step.
- LLM-guessed variables with no person to confirm them (see the July page).
- A separate DSL. If Alfred ever stores a program, there is a closer candidate: **the Code Mode script of a successful run** (ADR-0124). Code Mode already turns a read-heavy turn into a program over typed tools, and it is settled. Saving "the script that this run executed", as Claude Code's `/workflows` does (July page, P1), uses one artifact for two jobs. This is a thought for later, not a proposal: Code Mode is not built (#535), and its scripts do not make writes when a person is present.

### Questions for the owner

1. **Is the spend real?** Are authored workflows a token cost worth a mechanism, or are triage, briefing, and chat where the tokens go? A measurement (runs per day × tokens per run, from the run ledger) should answer this before any design.
2. **On deviation, what happens?** Fall back to the full boss loop (costs tokens, may differ from the recording), or stop and push the user (costs attention)?
3. **Does a compiled revision need a fresh approval card?** This page says yes.
4. **Does the MCP gap close first?** Most replayable reads are now MCP. A replay tier cannot ship until a workflow with `mcp.call` can activate, and that waits on the workflow-surface rewrite.

### Owner decisions, 2026-11-14

1. **The spend check is approved.** Measure from the run ledger before any design (the measurement of 2026-11-14 is recorded in section 4a, if present).
2. **On deviation, fall back to the boss harness.** Workflows are authored on the user's ask and stored; when an assumption breaks or something unforeseen happens, the run falls back to the boss/worker harness.
3. **A compiled revision gets a fresh approval card.** Confirmed.
4. **Alfred has access to all connections.** The MCP activation gap closes in the workflow rewrite; a workflow may use every connection the user has, under the approval rules that already exist.

### 4a. The spend measurement, 2026-11-14

Answer to question 1, from prod (read-only SELECTs; ledger = `api_call_log`, cost priced at write time, ADR-0015):

- **Zero user-authored workflows exist.** `workflow_revisions` has 0 rows; every `agent_runs` row has `workflow_revision_id IS NULL`; the 8 `workflows` rows are seeded built-ins from 2026-09-06. Authored-workflow token spend is $0.00 — the premise of question 1 fails on existence, not magnitude.
- **All-time spend, Sep 6 – Nov 14 (~70 days): ≈ $14.78 total, ≈ $0.10–0.21/day.** By scope: daily-briefing $5.71 (gpt-6-luna, the per-dollar leader), embeddings $5.38 (voyage-3.5, 99.9% of the no-run bucket, zero output tokens), email-triage $2.29 (gemini-2.5-flash-lite, the call-volume leader at 1,262 runs/30d, ~$0.001 each), memory-extraction $0.72, chat $0.59 (sparse: 16 runs/30d), cold-start $0.08.
- **Conclusion:** a replay mechanism cannot be justified by tokens today. If it ever comes, the case is attention or reliability, not cost. The whole pipeline is an order of magnitude below any cost-based design argument.

## 5. Verdict

**Adapt ideas, do not adopt the project.** workflow-use is evidence that the shape works in principle: a stored list of typed steps with model nodes marked in the artifact, so that a repeated run pays for the model only where judgment is needed. That is the same shape as core-agent.md's spine and rung 3 of the workflows-v1 ladder. But as software it is browser-only, AGPL, and not maintained by its own authors' statement. Its run-time story is weaker than its README: no agent fallback, no repair, and a required model step on each run. Under principle 6, the mechanism has no product job yet. The measurement of 2026-11-14 (section 4a) settles it further: no user-authored workflow has ever existed in prod, and the whole pipeline costs about $0.10–0.21 a day, so tokens justify nothing here. And the steps that a replay would most likely store are now MCP calls with remote schemas, which brings back the brittleness that a typed substrate was meant to remove. Keep the ideas in section 4 for the workflow-surface rewrite. Do not file work from this page.
