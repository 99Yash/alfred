---
status: in-progress
evidence: "PR 1 is #1609 (merged). PR 2 is #1610 (merged). PR 3 is #1611 (merged). PR 4 is #1613 (open)."
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
8. **One derivation for every consumer.** `deriveEffectiveTriage` in `triage/effective.ts`
   takes the stored row, the consumer's document, and the current instructions. A stored scope
   result counts only when the row's `documentId` is the consumer's document and the revision
   is current. A row with no model verdict (from before ADR-0113, or the classifier fallback)
   keeps its cached result, because to apply the effects again could undo a secret hold.
9. **The security floor holds a briefing exclusion.** When the exposed-secret signal fired, an
   `exclude_briefing_priority` changes nothing. It does not hold a `block_reply_draft`, because
   a block is never less safe.

10. **An exception cancels by the E2 rule.** To cancel a raise is a lowering, so it needs full
    cover of the exception. To cancel a lowering is a raise, so any part is enough. Each effect
    of the broader instruction is tested on its own. A target hit of an exception is full cover.
11. **`include_briefing_priority` is "not enforced".** Briefing gather has no bucket for an
    item outside the priority categories. Capture cannot write the effect, and the words stay
    prose. The registry keeps the effect, so a stored inclusion still cancels an exclusion. The
    owner decided this on 2026-10-29. Issue #1612 adds the bucket.
12. **The confirmation is an approval card that always shows.** `system.remember` uses a new
    staging arm, `confirm`: a staged write with `forcesApproval`, so chat full autonomy does
    not waive it. The card shows the structured fields (words, scope, targets, effects,
    exception). The arm needs a live chat, so a background workflow cannot store an
    instruction. The owner decided this on 2026-10-29.
13. **A database trigger owns the set revision.** A row trigger on `user_facts` (migration 0154) raises `standing_instruction_set_revisions.revision` at each insert, delete, or
    visible update of a `standing_instruction` row. Code no longer raises it, so a new writer,
    a script, or hand SQL cannot leave a stale revision. An update that changes no value,
    status, or validity window does not count.
14. **An `unknown` exception does not cancel.** This follows rule 4: an `unknown` state applies
    no rank effect. For a lowering exception of a raise, this is the safe direction. For a
    raising exception of a lowering, the item stays lowered until triage or the re-match job
    reads the exception.
15. **`system.remember` takes only the v2 shape.** Code mints the instruction id. A revision
    passes `instructionId` and `expectedRevision`, keeps the id, and adds 1 to `revision`. If
    a different revision is active when the user confirms, capture stores nothing and returns
    `stale_revision`, unless the active row already holds the same content. A domain target must
    belong to one organization (the v1 rail). `edit_instruction` stays for v1 rows until PR 5.
    The v1 writer stays for the backfill script until PR 5.
16. **Capture refuses an unresolved structural conflict.** An active instruction that names
    the same, a wider, a narrower, or an overlapping sender is a conflict (ADR-0060
    micro-decision 6). Overlapping means the two share mail but neither contains the other,
    for example a domain in one mailbox and an address at that domain in every mailbox. The
    input must resolve each one: `replaces` (closed in the same transaction), `exceptionOf`,
    or `coexistsWith`. Else `system.remember` stores nothing and returns `conflict`. The same
    check runs before the card, so the card shows the choice that the write binds to. It runs
    only for a fresh proposal (`refuseProposal`): a replay or a resume of the same tool call
    skips it, so a saved result still replays. The write checks again under the capture lock.
    A duplicate returns `already_exists` before the conflict check, but it still closes the
    rows that `replaces` names. Capture keeps two things apart: the stored content (a new row
    or an existing one) and the rows that the operation closes.
17. **The capture sweep follows the effective result.** The todo sweep dismisses a todo only
    where `deriveEffectiveTriage` blocks it now and the new instruction matches. So an
    exception that cancels the block keeps the todo. All targets go in one write. A failed
    sweep keeps the instruction and returns `sweep_failed`. The same call again returns
    `already_exists` and sweeps again. `replaces` states an end state, so an id that is
    already retired passes and closes nothing. A repeat after a replacement then still plans.
18. **A scope can be bound to one mailbox.** A v2 value can carry `accountId`. A scope match
    then needs mail of that mailbox. Capture writes it when the input has a scope and an
    `accountId`. Targets and `senderFilter` keep their own `accountId`.
19. **Capture reads its clock after the lock.** `now()` is the transaction start, so a waiter
    could miss a row that a rival committed during the wait. Capture and forget read
    `clock_timestamp()` after the lock and use it for the active read and for the write.

## Pull requests

| PR  | Content                                                                                                                                                                                                                                                                                                      | Behavior change                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| 1   | The v2 contract: the value schema, the effect registry with the direction of each effect, and the coverage rule. The reader lifts v1 rows. Each consumer reads the stored effects of the v2 view.                                                                                                            | None. A v1 row gives the same four effects that it enforces today.                              |
| 2   | The set-revision table and the two `email_triage` columns. Triage stores the model verdict and the evaluation. The instruction floor runs last and applies the stored effects with the direction rule. The scoped block in the classify prompt, the matched ids with a reason and `covers`, and the counter. | None until a scoped instruction exists. The ADR-0106 prior line for a sender leaves the prompt. |
| 3   | Briefing gather, the briefing reads, the two reply-draft gates, and the todo decision derive the effective result under the three states (`matched`, `not_matched`, `unknown`).                                                                                                                              | A removed instruction stops at the next read.                                                   |
| 4   | (#1613) Capture: the v2 arm of `system.remember`, list, and forget, with the confirmation card and the revision trigger.                                                                                                                                                                                     | The owner can store a scoped instruction. Old mail stays `unknown` for it.                      |
| 4b  | The re-match job: an instruction write enqueues one bounded match-only pass over the mail that a consumer can still read.                                                                                                                                                                                    | A new scoped instruction reaches old mail.                                                      |
| 5   | The migration script for the 21 v1 rows, with the owner's review of each row, and the rollout-gate replay.                                                                                                                                                                                                   | The investment instruction becomes one scoped instruction.                                      |

PR 5 needs the owner at the keyboard. Each other PR can merge when its checks pass.
