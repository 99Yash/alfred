---
name: campaign
description: Work a review artifact (architecture report, audit, issue list) item by item to merged PRs, with a harsh structural review round-trip on each. Splits the work into fixed phases so each phase runs in a fresh context.
---

# Campaign

A **campaign** turns a list of findings into a queue of items, and walks each item
through a fixed phase machine until it is a green PR waiting to merge.

The point is not automation for its own sake. It is that **one phase = one fresh
context**. Design does not carry implementation's file reads; review does not carry
design's reasoning; round 2 of review does not carry round 1. A twenty-item report
that would blow through any single window becomes forty small turns that each start
near empty.

## Anatomy

```
.campaign/<slug>/
  source.html            the original artifact, copied so TMPDIR cleanup can't eat it
  state.json             machine state — the queue, and each item's phase/round/PR
  items/NN-slug.md       one file per item: the extracted finding, then design notes,
                         then one section per review round. THE working document.
  NOTES.md               cross-item scratchpad — what one item learned that another
                         needs. Read at the start of every phase, kept short.
  reviews/NN-rN-*.md     raw subagent review output, kept for audit
```

`state.json` is the contract between phases and the driver. `items/NN-slug.md` is the
contract between one phase and the next. **A phase that does not update both has not
finished**, and the driver will mark the item stuck.

There is deliberately no per-iteration handoff document. The item file _is_ the
handoff, and a second parallel record would leave the next phase deciding which one
is current. What the item file must carry — because a killed phase writes nothing at
all — is incremental checkpoints and rejected approaches, not just conclusions. For
knowledge that outlives the campaign, the door is `/learn` → `.lessons/`, which the
recall hook surfaces in future sessions on its own.

## How to run it

**Every phase after intake runs headless, through `scripts/campaign.sh`. This
applies to a one-item campaign too.** Do not run design, implement, review, revise,
or land in the session that invoked `/campaign`. The owner wants each phase in its
own shell, and a session that runs phases back to back carries every file read into
the next phase.

`/campaign <path-to-artifact>` runs intake in session, because intake is the only
phase that reads the whole artifact. `/campaign` with no argument continues the
existing campaign. In both cases, the session then starts the driver in the
background, monitors the log, and reports the result. It does not do the phase work.

The driver is a Ralph loop: pick the next `(item, phase)`, spawn a fresh `claude -p`
or `opencode run`, stream it, verify state moved, repeat. Each iteration gets its
own window, so the budget is structural rather than aspirational.

**Models.** Use these unless the owner names others:

- `claude` phases: Opus 5.5 at high effort. The driver passes no model or effort
  flag to `claude -p`, so set `ANTHROPIC_MODEL=claude-opus-5-5` and
  `CLAUDE_CODE_EFFORT_LEVEL=high` in the environment.
- `opencode` phases: `MODEL='meta/muse-spark-1.3#high'`. A per-phase override is
  `<PHASE>_MODEL`, for example `REVISE_MODEL`.
- Keep review on `claude`, because only `claude` runs the three review lanes as
  real subagents. The write phases can go to `opencode` (`REVISE_ENGINE=opencode`,
  and so on).

```bash
# the standard launch: review on claude, revise on opencode
SLUG=<slug> ITEM=01 REVISE_ENGINE=opencode MODEL='meta/muse-spark-1.3#high' \
  ANTHROPIC_MODEL=claude-opus-5-5 CLAUDE_CODE_EFFORT_LEVEL=high \
  scripts/campaign.sh

DRY_RUN=1 scripts/campaign.sh        # print the prompts, invoke nothing
ITEM=07 scripts/campaign.sh          # one item only — the way to smoke-test the harness
MAX_ITER=4 scripts/campaign.sh       # cap iterations
```

## The phase machine

| Phase       | Does                                                                                                                                                                                              | Ends by setting                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `intake`    | Artifact → one item file per finding, `state.json` queue. Reconciles against `git log` **and merged/open PRs** to drop findings already landed. **The only phase that reads the whole artifact.** | every item to `design` or `cover`    |
| `cover`     | Lands the tests a finding says must exist _before_ the refactor. Own PR, merged first.                                                                                                            | `design`                             |
| `design`    | Reads only the cited lines. Writes the invariant, the interface sketch, the edit list, the test plan.                                                                                             | `implement`                          |
| `implement` | Worktree, branch, TDD at the agreed seam, `pnpm check && pnpm check-types`, commit, push, draft PR.                                                                                               | `review`                             |
| `review`    | Three parallel subagents over the PR diff — structural **up**, structural **down**, `code-style` sweep — synthesized into must-fix / follow-up / won't-fix.                                       | `revise`, or `landed` if no must-fix |
| `revise`    | Must-fix only. Push. Round++.                                                                                                                                                                     | `review`                             |
| `land`      | PR out of draft, item closed, follow-ups appended to the queue as **new items**.                                                                                                                  | `landed`                             |

Terminal phases: `landed`, `needs-human`, `skipped`.

Full instructions per phase are in **[PHASES.md](PHASES.md)**. The review protocol is
in **[REVIEW.md](REVIEW.md)**. Read only the section for the phase you are running.

## The five rules that keep it from running away

1. **One phase per invocation.** Finish the phase, update state, stop. Do not roll
   into the next one because it "looks quick" — that is exactly how a context
   window fills up.
2. **Never re-read the artifact after intake.** The item file is the finding. If
   the item file is missing something, fix the item file.
3. **Follow-ups become new queue items, never scope inside the current one.** A
   review that discovers a second problem records it and moves on. This is the
   single rule that stops an item from looping forever.
4. **Delegate reading, not deciding.** Broad searching goes to `Explore`
   subagents that return conclusions. Review passes go to subagents whose file
   reads never enter this context. Judgment stays here.
5. **Round cap.** Three review rounds. If must-fix findings survive that, the item
   goes `needs-human` with the open findings written down, and the queue moves on.
   A loop that cannot converge should say so, not keep spending.

## Stop conditions

The loop halts on: an empty queue, `MAX_ITER`, a per-iteration budget overrun, a
push failure, a dirty main checkout, or an item making no state progress. Every one
of those leaves `state.json` readable and the campaign resumable.
