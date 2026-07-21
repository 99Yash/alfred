# Loop engineering — `plan-loop.sh`

Execute a big plan across **many fresh Claude Code sessions** instead of one long
one. Every iteration starts with a clean context window and works one bounded
slice, so no session ever drifts near the ~140k-token fidelity cliff. Continuity
rides on files, not on a single window's memory.

## Why fresh sessions, not a 140k trigger

There is no native "context reached N tokens" hook — Claude Code hooks are
event-driven (`SessionStart`, `PreToolUse`, `PreCompact`, …), not
threshold-driven, and a hook can't restart the session anyway. So rather than
*detect* the cliff mid-flight (fragile — you'd interrupt mid-edit and write the
worst handoff), we *avoid* it: bound each step to one clean context, and loop.

## The two state files

| File | Role | Loaded how |
|---|---|---|
| `.loop/plan.md` | **Ledger** — checkboxes = machine-checkable "done?" state | read by the orchestrator every iteration |
| `.handoff/*.md` | **Narrative ore** — what the last session did/tried/left | the next session reads the newest one |

The ledger is the *exit condition*; the handoff is the *resume context*. Both are
produced by the existing `handoff` skill; the loop just adds the ledger discipline
on top.

## How one iteration works

```
1. fresh `claude -p` session
     reads .loop/plan.md + newest .handoff/
     implements the first unchecked step (bounded slice)
     runs the gate itself; marks [x] only if green; writes a handoff
2. orchestrator re-runs the gate (authoritative — never trusts self-report)
     red   -> STOP, nothing committed, tree left for you to inspect  (gated)
     green -> git commit this iteration, loop
3. when only @structural-review is left -> final review pass over the full diff
     -> writes .loop/review.md, stops for you to act on findings
```

Safety net (gated autonomy): branch guard (refuses `main`), per-iteration commit,
the gate as a hard stop, stall detection, and a `MAX_ITERS` cap.

## Usage

```bash
# 1. Fill in the plan
$EDITOR .loop/plan.md          # ordered steps, @structural-review last

# 2. Be on a feature branch with a clean-ish tree
git switch -c my/loop-work

# 3. Run
./plan-loop.sh                 # gate defaults to `pnpm check-types`

# Variants
DRY_RUN=1 ./plan-loop.sh                              # simulate, run nothing
MAX_ITERS=8 ./plan-loop.sh                            # cap iterations
TESTS="pnpm --filter @alfred/api test" ./plan-loop.sh # add a test gate
MODEL=opus ./plan-loop.sh                             # pin a model
```

Environment knobs: `MAX_ITERS`, `GATE`, `TESTS`, `MODEL`, `STALL_LIMIT`,
`CLAUDE_PERM`, `DRY_RUN`. See the header of `plan-loop.sh`.

## Notes & caveats

- **Unattended = skip-permissions.** For no per-tool prompts the loop passes
  `--dangerously-skip-permissions`. The branch guard + gate + per-iteration commit
  are what make that acceptable. Override with `CLAUDE_PERM="--permission-mode acceptEdits"`
  if you'd rather it prompt on bash.
- **Resume anytime.** Kill it, inspect, `./plan-loop.sh` again — it reads the
  ledger fresh. `.loop/base.sha` pins the review diff base for the whole run;
  delete it to re-baseline.
- **The gate is the truth.** If the agent checks a box but the gate is red, the
  loop stops rather than commit a lie.
- `.loop/` and `plan-loop.sh` are gitignored (personal tooling, like `.handoff/`).
