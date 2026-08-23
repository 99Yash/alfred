# An AI coding benchmark for Alfred

Status: designed 2026-08-16; first slice built and first clean datapoint produced
the same day (`a-834`, `opencode/big-pickle`, ~20 min, pass). Process lane
shipped 2026-08-17: five deterministic rules over trajectory JSONL. Two
contamination vectors discovered during the first runs and fixed: the agent can
retrieve the answer from local git history (fixed by a hermetic depth-1 clone)
and from the GitHub API (fixed by anonymizing prompts and adding a behavioral
contract). The field survey cites the papers and first-party documents in
Sources. The design applies to Alfred and, with small changes, to any TypeScript
monorepo.

## Executive conclusion

A coding benchmark is a fixed set of tasks with a fixed way to grade the result.
It answers one question: did the coding agent get better?

The field builds a benchmark from four parts: the task set, the runner, the
verifier, and the metric. The public benchmarks share the same weaknesses. Their
tasks are public, so models can memorize them. Their harness often changes the
score more than the model does. Their verifier is usually the test suite, so they
never grade the process the agent used.

Alfred can build a benchmark that is private, that grades the process, and that
uses its own checks as the verifier. No public benchmark does these three things.
The first slice is small and needs no new dependency.

## The problem a benchmark solves

1. You cannot see progress. When you change a model, a tool, or a prompt, you do
   not know if the coding agent improved.
2. You cannot compare choices. Two agents or two tool sets need the same tasks
   and the same grading to compare.
3. One success proves nothing. A single run that passes is noise. You need many
   tasks to see a pattern.
4. The old behavior must survive. The usual failure of a change is a regression,
   not a missing new capability.

## How the field builds benchmarks

A benchmark has four parts: tasks, runner, verifier, metric.

### Tasks

The task is the prompt plus the starting state of the repository. The field has
five sources for tasks:

1. **Real history.** [SWE-bench](https://arxiv.org/abs/2310.06770) takes a real
   GitHub issue and the pull request that fixed it. The issue text is the prompt.
   The merged diff is the gold answer. Tests that failed before the fix and
   passed after it form the grade.
2. **Synthetic mutation.** [SWE-smith](https://arxiv.org/abs/2504.21798) and
   [R2E](https://proceedings.mlr.press/v235/jain24c.html) inject a bug into real
   code. The repository's tests must catch the bug.
3. **Generated programs.** [CodeWorld](https://arxiv.org/abs/2510.02387) creates
   new programs and verifies them with humans.
4. **Real economics.** [SWE-Lancer](https://arxiv.org/abs/2502.12115) uses real
   freelance tasks with a real dollar value.
5. **Human time.** [METR](https://arxiv.org/abs/2503.14499) times an expert human
   on each task. The metric is the task horizon: the number of human minutes or
   hours the agent automates at 50% success.

### Runner

The runner is the harness. It gives the agent a clean checkout, a shell, an
editor, and a budget of turns, tokens, and time. The lesson from
[SWE-rebench](https://arxiv.org/abs/2505.20411) is that the harness is the
benchmark. The same model scores 40.0% under one harness and 62.4% under another.
A benchmark measures the pair (model, harness), never the model alone.

### Verifier

The verifier decides if the result is correct.

1. **Hidden tests.** The agent does not see them. This is the most common form.
   The risk is a test that is too specific, too weak, or leaked.
2. **Deterministic state checks.** [τ-bench](https://arxiv.org/abs/2406.12045)
   compares the database state at the end of the run with the target state. It
   refuses a model judge.
3. **Human graders.** They are accurate and expensive.
4. **LLM judges.** They are fast and noisy. Their agreement with a human is about
   0.70 to 0.76 on a clean binary question
   ([ResearchRubrics](https://arxiv.org/abs/2511.07685)).

### Metric

The common metric is the resolve rate: the fraction of tasks the agent fixed. The
field adds pass@k, the resolve rate with k attempts, and cost@k, the same rate
with a budget of tokens.

## What the field does not solve

1. **Contamination.** Public tasks enter training data. A public benchmark decays
   with time. The SWE-bench team's own issue
   [#217](https://github.com/SWE-bench/experiments/issues/217) documents
   submissions that modified the tests.
2. **Harness dominance.** The scaffold often changes the score more than the
   model does.
3. **Verifier correctness.** A test or judge that is wrong marks good work as bad.
4. **Real product work.** Benchmarks measure well-scoped bugs. They do not
   measure ambiguous requirements or long tasks.
5. **The process.** A diff that passes the tests can still be lucky. The agent can
   reach the right answer the wrong way.
6. **Monorepos.** No public standard exists for a TypeScript monorepo with
   package boundaries, package exports, and generated schemas.

## What Alfred already has

1. **A deterministic verify command.** `pnpm verify` runs the checks, the
   type-check, and the deterministic tests.
2. **A set of structural checks.** `check:architecture`, `check:web-boundaries`,
   `check:exports`, `check:type-fixtures`, and `check:consolidation` are machine
   graders for the repository's own rules.
3. **An eval lane.** The lane in `packages/assistant/evals` already grades the
   process, not only the answer. Its scorers are deterministic where possible and
   use an LLM judge for the residue.
4. **A governance rule.** ADR-0055 says the eval informs a human; it never tunes
   a prompt by itself.
5. **A task source.** The remote has 581 merged pull requests since 2026-04-29.
   The local history was rewritten in July 2026, but the remote retains every
   pull request. `docs/plans` holds briefs and ADRs.
6. **A replay check that passes.** I fetched the base commit of pull request #1
   from the remote. The fetch succeeded. A task can check out any historical
   state, even a state older than the rewritten local history.

## The benchmark design for Alfred

The design keeps the field's four parts and adds a fifth: the process lane.

### The task set

Three tiers. Each tier uses a different source.

**Tier A — real history (SWE-bench style).** A closed issue and its merged pull
request make one task. The issue text is the prompt. The base commit is the
starting state. The test that the fix introduced is the verifier. The merged diff
is the gold answer. Alfred has 581 merged pull requests on the remote and a
closed-issue history to draw from. The runner fetches the base commit from the
remote before it checks out the state.

**Tier B — invariant recovery (mutation style).** Take a current feature and
remove the code that enforces one of its invariants. The existing contract test
fails. The task is to restore the behavior. This is the safest self-made task:
the repository's own tests are the verifier, and the task is fresh and private.

**Tier C — structural change (no public equivalent).** The verifier is a
repository check, not a test. Examples: add a feature without crossing a package
boundary; move a module and keep the exports valid; change a Drizzle row type and
fix every derived consumer; use the canonical helper and pass
`check:consolidation`. These tasks grade exactly what the repository's
enforcement ladder protects.

### The runner

The runner uses a clean git worktree at the task's base commit. It gives the
agent the task file, the repository, and a shell. It records the trajectory:
every command, every edit, every test run. It sets a budget of tokens, time, and
cost. At the end it takes the diff and applies it to a fresh checkout.

### The verifier

The verifier runs in this order:

1. The hidden tests for the task.
2. The structural checks for the tier.
3. The full `pnpm verify` for regressions.

The verifier is deterministic. It never uses an LLM judge for the pass or fail
decision.

### The process lane

The process lane grades how the agent worked. It is code over the trajectory, not
a model judge. Examples:

1. The agent ran `pnpm verify` before it declared the task done.
2. The agent edited only the files that the task allows.
3. The agent did not re-hand-roll a helper that a check forbids.

Each rule is a predicate. Each rule gets a pass count with an occurrence
denominator. The lane follows the design in
[`process-supervision-and-behavior-specs.md`](./process-supervision-and-behavior-specs.md).
The lucky-correct case is a required fixture: an outcome that is right and a
process that is wrong must come out negative.

### The metric

1. Resolve rate per tier.
2. Cost per resolved task, in tokens and dollars.
3. Difficulty bands. Time an expert human on a sample. Report the resolve rate
   per band. The band where the rate crosses 50% is the task horizon.
4. Per-rule process pass counts. Never one headline number.
5. Judge calibration. Hand-label a subsample and report Cohen's kappa for any LLM
   judge.

## Why this goes beyond the field

1. **The benchmark is private.** It runs on the repository's own history and
   state. It cannot leak into training data.
2. **The process is graded, not only the diff.** The field measures the outcome;
   this design measures the path as well.
3. **The repository's own checks are the verifier.** No public benchmark grades
   package exports, web boundaries, or the consolidation rules.
4. **The tasks version like ADRs.** Each task file has a date and a base commit.
   A check can detect a task that drifted from the current state.
5. **The metric reports difficulty and cost, not one number.**
6. **ADR-0055 governs the lane.** The result informs a human; it never tunes a
   prompt by itself.

## The first slice

Built in this repo under `scripts/bench/`:

1. **`manifest.mjs`** — the task manifest format and its validator. A task is a
   directory `scripts/bench/tasks/<id>/` with `manifest.json`, `prompt.md`, and
   for tier a the two split patches. The shape is
   `{ id, tier, title, base, source, promptFile, testPatch, goldPatch,
hiddenFiles, verify, targetFiles, createdAt }`. The conduct rule
   `no-hidden-test-edits` is derived from `hiddenFiles`; there is no separate
   conduct field.
2. **`mine-task.mjs`** — `--id a-834 --pr 834 --verify "cmd"` reads the PR from
   GitHub with `gh`, strips `## What this change does` from the prompt (that
   section is the answer), and splits the PR diff into the hidden test patch and
   the gold patch by the `*.test.*` / `*.selftest.*` naming rule.
3. **`run.mjs`** — creates a disposable clone with `git fetch --depth 1` at the
   task's base commit, adds a git worktree, writes `TASK.md`, runs
   `opencode run --format json --auto` under a wall-clock timeout, and records
   the trajectory and the final diff under `references/bench/<id>/<timestamp>/`.
   The depth-1 fetch means no other commit — and no answer — is reachable in
   the worktree. Both the clone and the worktree are removed after every run.
4. **`grade.mjs`** — replays the submission at the base commit, restores any
   hidden file the agent touched, applies the hidden test patch, runs the
   verify commands, and reports `pass` or `fail`. `--gold` and
   `--check-discriminator` validate a seed task. When a trajectory file is
   available, the grader also runs the process lane over the trajectory.
5. **`process-lane.mjs`** — deterministic predicates over the opencode
   trajectory JSONL. Each rule is a pure function over the parsed tool-call
   sequence. Five rules ship: `ran-verify-before-finish`, `no-hidden-file-edits`,
   `no-network-access`, `no-selftest-creation`, `no-git-mutations`. Process
   violations cause a `fail` verdict (the lucky-correct case: right outcome,
   wrong process, must come out negative).
6. **`aggregate.mjs`** — reads `report.json` files from `references/bench/`,
   prints per-task and per-model summaries, and reports conduct and process
   lane violations.
7. **Five tier-a seed tasks and one tier-c.** `a-834` and `a-650` pass (both
   `opencode/big-pickle`, ~20 min and ~15 min respectively). `a-852` fails: the
   agent created the selftest file, violating the "don't edit test files"
   conduct rule — a valid process-lane negative. `a-856` and `a-855` are
   validated (gold passes, discriminator holds) and ready for agent runs.
   `c-contracts-slack-action` is a type-driven tier c task; its four verify
   commands pass on the clean base and on a correct solution.

Every bench script passes `pnpm check` and the scripts type-check program.

### The first runs

Five tier-a tasks ran against `opencode/big-pickle` (the model that powers
this session). Two passed, three failed:

| Task  | Verdict | Time  | Notes                            |
| ----- | ------- | ----- | -------------------------------- |
| a-834 | pass    | 101s  | Clean solve, offline             |
| a-650 | pass    | 927s  | Clean solve, with install        |
| a-852 | fail    | 1135s | Agent created selftest (conduct) |
| a-856 | fail    | 1112s | Agent couldn't solve (verify)    |
| a-855 | fail    | 2742s | Timeout + edited hidden file     |

Pass rate: 2/5 (40%). The two passes are fast (1–15 min). The fails show
three distinct failure modes: conduct violation, inability to solve, and
timeout with conduct violation. The process lane caught two of the three
fails (a-852 and a-855); a-856 failed only on verify (correct process,
wrong solution).

### What the first runs revealed

1. **Two contamination vectors.** (a) The agent called `git log --all` and found
   the real solution commit, then replayed it. A hermetic clone fixes this:
   `git fetch --depth 1` makes no other commit reachable. (b) The agent called
   `gh pr diff 834` and replayed the real PR from GitHub. Anonymizing prompts
   fixes this: the task says "the commit the task starts from" and adds a rule
   "do not use the network."
2. **Real-history tasks are under-specified by default.** The PR body describes
   the bug and the author's proof, but the hidden test encodes requirements the
   author never stated (e.g. refusing a self-prereq, `null` → `[]`). The fix is
   a behavioral contract in the prompt that states every requirement the hidden
   test checks. The miner must synthesize this contract from the test patch for
   future tier-a tasks.
3. **The process lane caught a lucky-correct case.** The contaminated agent
   produced a correct diff via answer retrieval. Conduct flagged it (edits a
   hidden file); grading returned `fail`. The design's negative-verdict rule
   worked.

## Open questions

1. The harness is `opencode run` (see Status). It has no native budget flag, so
   the runner bounds each run by wall-clock time.
2. ~~Which rules belong in the process lane first?~~ Shipped: five rules
   (`ran-verify-before-finish`, `no-hidden-file-edits`, `no-network-access`,
   `no-selftest-creation`, `no-git-mutations`). Next: add rules from the
   finalize guards and measure their hit rate across runs.
3. Where does the benchmark run? A local runner is enough for the seeded tasks;
   a GitHub Actions workflow is the next step.
4. The miner must synthesize a behavioral contract for each tier-a task. The
   contract states every requirement the hidden test checks. The current a-834
   and a-650 contracts were hand-authored; automating this is the next miner
   change.
5. ~~Tier c has no discriminator: the verify commands pass on the clean base, so
   an empty diff would pass. Grading tier c needs a review step that checks the
   diff reached the intended files.~~ Shipped: `targetFiles` field in the
   manifest; the grader checks that the agent's patch modifies at least one
   listed target file.
6. The seed set has five tier-a tasks (`a-834`, `a-650`, `a-852`, `a-856`,
   `a-855`) and one tier-c task. Two more tier-a tasks (`a-850`, `a-848`) are
   mined but need live Postgres. The tier-a target is five offline tasks — met.

## Sources

- SWE-bench: https://arxiv.org/abs/2310.06770
- SWE-bench Verified: https://openai.com/index/introducing-swe-bench-verified/
- SWE-rebench: https://arxiv.org/abs/2505.20411
- SWE-smith: https://arxiv.org/abs/2504.21798
- R2E: https://proceedings.mlr.press/v235/jain24c.html
- Commit0: https://arxiv.org/html/2412.01769
- CodeWorld: https://arxiv.org/abs/2510.02387
- SWE-Lancer: https://arxiv.org/abs/2502.12115
- METR task horizon: https://arxiv.org/abs/2503.14499
- τ-bench: https://arxiv.org/abs/2406.12045
- Terminal-Bench: https://arxiv.org/abs/2508.10805
- MLE-bench: https://arxiv.org/abs/2410.07095
- Aider polyglot: https://aider.chat/2024/06/13/polyglot.html
- Multi-SWE-bench: https://arxiv.org/abs/2504.02605
- ResearchRubrics: https://arxiv.org/abs/2511.07685
- SWE-bench experiments issue #217: https://github.com/SWE-bench/experiments/issues/217
