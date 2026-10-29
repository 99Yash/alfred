---
status: in-progress
evidence: "PR 1 is #1609 (merged). PR 2 is #1610."
---

# Standing instructions v2, step 1: the base design of ADR-0113

Step 1 of the ADR-0113 build order, with the additions of the 2026-10-29 amendment
(`covers`, the direction rule of E2, the counter, and `notes`). Cues, anchors, and relation
words are step 2 and are not in this plan.

## Implementation decisions

These choices are not in the ADR. Each one is the smallest choice that keeps an ADR rule.

1. **A stable instruction id.** An edit closes the old `user_facts` row and inserts a new one,
   so the fact id changes at each edit. A v2 value carries its own `instructionId` and
   `revision`. Capture mints the id. An edit keeps the id and adds 1 to `revision`.
   `exceptionOf` and every stored match use the instruction id, never the fact id.
2. **A v1 row reads as a v2 instruction.** The reader lifts a v1 row to a v2 view: one sender
   `target`, no scope, `instructionId` = the fact id, `revision` = 0, and the effects that
   ADR-0106 and ADR-0110 enforce today: `demote_demand`, `block_todo_suggestion`,
   `exclude_briefing_priority`, and `block_reply_draft`. Thus each consumer moves to the v2
   reader with no change of behavior, and the migration (PR 5) changes only data.
3. **The instruction-set revision is one row for each user** in a new table. Each instruction
   write increases it in the same transaction.
4. **The model verdict and the evaluation live on `email_triage`.** Two new `jsonb` columns:
   the model verdict before any instruction effect, and the evaluation (set revision, and the
   result of each scoped instruction). `email_triage.document_id` is the content revision. The
   existing `category`, `document_ask`, and `todo_suggestion` columns become the cached
   effective result (rule 5). A reader parses both columns with the contract schema.
5. **The instruction floor runs last.** It moves after the meeting floor. Thus the stored model
   verdict is the output of the system floors, and one pure function derives the effective
   result from it. Triage and every consumer call the same function, so they cannot disagree.
   The verdict also stores whether the exposed-secret signal fired, so that a consumer can apply
   the security floor with no mail text.
6. **Only `demote_demand` and `demote_meeting` clear the ask and the todo.** `force_category`
   sets only the category, also when it sets `fyi`. Each effect does one thing, and
   `block_todo_suggestion` is the effect that clears a todo.
7. **The match list fits in the output allowance.** At most 24 scoped instructions go into one
   classify prompt, and the output allowance holds a match for each. If the output still fails
   with the match list, the pass runs again without it. The verdict stays, and each sent
   instruction is `unknown`. The trace records `standingMatchFailure`.

## Open before PR 4

PR 4 lets capture write a scoped instruction and an `exceptionOf`. These points need a decision
first.

- **An exception on part cover.** Now an exception cancels the broader instruction before the
  cover check, so a `part` scope match of an exception cancels a sender-wide raise. The
  recommendation is to apply E2 to the cancellation: to cancel a raise is a lowering, so it
  needs full cover; to cancel a lowering is a raise, so any part is enough.
- **One owner for the revision.** Each `facts.ts` write branch now calls `noteFactKeyWrite`.
  A new branch that does not call it leaves a stale revision. PR 4 puts the instruction write,
  the revision increase, and the re-match job behind one function.

## Pull requests

| PR  | Content                                                                                                                                                                                                                                                                                                      | Behavior change                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| 1   | The v2 contract: the value schema, the effect registry with the direction of each effect, and the coverage rule. The reader lifts v1 rows. Each consumer reads the stored effects of the v2 view.                                                                                                            | None. A v1 row gives the same four effects that it enforces today.                              |
| 2   | The set-revision table and the two `email_triage` columns. Triage stores the model verdict and the evaluation. The instruction floor runs last and applies the stored effects with the direction rule. The scoped block in the classify prompt, the matched ids with a reason and `covers`, and the counter. | None until a scoped instruction exists. The ADR-0106 prior line for a sender leaves the prompt. |
| 3   | Briefing gather, the briefing reads, the two reply-draft gates, and the todo decision derive the effective result under the three states (`matched`, `not_matched`, `unknown`).                                                                                                                              | A removed instruction stops at the next read.                                                   |
| 4   | Capture: the v2 arm of `system.remember`, edit, and forget, with the one-line confirmation, the revision increase, and the re-match job.                                                                                                                                                                     | The owner can store a scoped instruction.                                                       |
| 5   | The migration script for the 21 v1 rows, with the owner's review of each row, and the rollout-gate replay.                                                                                                                                                                                                   | The investment instruction becomes one scoped instruction.                                      |

PR 5 needs the owner at the keyboard. Each other PR can merge when its checks pass.
