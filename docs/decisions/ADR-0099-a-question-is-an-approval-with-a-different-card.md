# ADR-0099 — A question is an approval with a different card (amends ADR-0034)

**Decision.** The chat boss asks the user a question with the tool `system.ask_user`. The dispatcher parks the chat turn on the same `wakeCondition.kind='hil'` wake and the same `action_stagings` row that a gated write parks on. The new approval kind `question` is the only difference the run machinery sees. The decision route, the row-version check, the expiry worker, the notification worker, and the Replicache approval queue serve a question unchanged. The kind selects the card and the copy.

Three sub-decisions follow:

1. **A question is an approval with a different card.** Alfred already has one complete human-in-the-loop path (ADR-0034): a staging row, a synced inline card, a decision route with row-version checks, a 24-hour expiry worker, and a debounced email. A question needs every one of those parts and no other part. opencode (`question` tool) and Dimension (`ASK_QUESTIONS` on the same `interrupts` row as write approvals) made the same choice. An in-process wait inside the tool is not possible: the dispatch lease is 60 seconds and a tool has no abort signal.
2. **The `system` autonomy rule forces a fourth staging arm.** `resolvePolicyMode` answers `autonomy` for every `system.*` tool before it reads the user's policy. The only risk tier that still gates under autonomy is `high`, and `high` means an irreversible action. A question is not an irreversible action, so it cannot reach the gate through a risk tier without a false label. The dispatcher gets a fourth arm, `staging: "question"`, next to `staged`, `fast_path`, and `join`. The arm forces `requiresApproval` without a policy read. Boot proves that only one tool declares the arm, that the tool is a `system` tool, that it accepts the question contract, that its model-facing schema hides the answer half, and that it is visible only to the chat boss on a live thread. This mirrors the `join` proof (ADR-0073).
3. **The tool schema carries the answer, and the model sees a narrower one.** `askUserInput` has an optional `answers` list, one entry per question. The decision route writes the user's answers into the row's `decided_input`. The dispatcher's ordinary resume path re-parses the decided input against the tool schema and runs `execute`, which returns the answers as a normal tool result. No new validation code or new route exists for the answer. The model is shown `askUserModelInput`, which has no `answers` key at all, so it cannot fill the user's field. The dispatcher still refuses a fresh call that carries answers, as a backstop. See **Two schemas, one tool** below.

**The kind is written once, on the wake, and never matched.** No column on `action_stagings` holds the approval kind. It lives in `agent_runs.wake_condition`, where the dispatcher writes it from the staging arm's row in `STAGING_ARM`. The decision route and the expiry worker match a wake on `(runId, approvalId)` alone. The staging id is a UUID, so the kind adds nothing to the match, and a kind re-derived at the match site could only disagree with the stored one. This keeps the tool registry out of `@alfred/http` and out of the workers. Readers that need to know a row is a question without the registry (the reason rule in the decision route, the notification email copy, the recent-rejection note, run metrics) compare the row's tool name to `ASK_USER_TOOL` from `@alfred/contracts`. Boot proves that the single `question` declarer is that tool, so the name and the arm cannot drift.

**One table per arm.** Everything the staged path does differently for a question lives in one row of `STAGING_ARM`, keyed by the staging arm: whether the approval is forced, which row statuses retry suppression matches, the wake kind and prompt, and how a settled row reads back to the model. A fifth arm is one row, and the compiler refuses a missing one.

**Amends ADR-0034.** ADR-0034 named two approval kinds, `step` and `action_staging`. This adds `question` and widens `approvalKindSchema`, the `approval.requested` event, and the signal route to the one enum in `@alfred/contracts`.

---

## What the user sees

The boss calls `system.ask_user` with an optional `context` paragraph and one to four questions. Each question has a text, a short header, two to six options with a label and a description, and a multi-select flag. The turn parks with `status = waiting`. The approval card appears in the chat and in the approvals tray. The composer stays disabled, as it does for a write approval. The user picks options or types a free-text answer and approves. The run wakes. The model receives `{ status: "answered", questions, answers }` and continues the same turn.

The card is the ported Dimension answer sheet (#1018). One question renders flat; two or more page one at a time, with a pager that marks which pages are still blank. Each question draws its options and a free-text field, and the primary button reads "Continue anyway" while any question is blank. The chat tray and the `/approvals` queue draw the same sheet from one component and differ only in the chrome above it. Slice 1's generic JSON editor is gone: a staged input the question schema refuses falls back to the ordinary write card, not to a raw editor. The tool description and prompt guidance are slice #1019.

Once the call settles, the turn keeps a read-only record of what was asked and what the user said, drawn from the tool result. See **The settled card reads a preview** below.

## Dismissal and expiry

A rejected row and an expired row both return an `unanswered` result, not a `rejected_by_user` result. The result carries `reason: "dismissed" | "expired"`, the original questions, and a message that tells the model to continue on a stated assumption and not ask the same questions again. Retry suppression for the question arm matches both `rejected` and `expired` rows. For a write, an expired row stays re-proposable, because the user may want the write. For a question, an expired set re-asked on the next step would park the turn on the same silence.

An unanswered question rides its own dispatch kind, `unanswered`. It is not a failed call: the tool-call log records `succeeded`, the chat card shows the neutral done label, the run metrics do not count the row as a rejected or expired staging, and the approval-wait span closes as `dismissed`, `answered`, or `expired`. A dismissal needs no reason. The decision route requires a reason for a write rejection because the reason is the revision note the model reads back; a question has no revision, so the route accepts an empty reason for a question row.

## The answer sheet

The decision route validates a question's edited input against `askUserDecidedInput` before it stores it. The edited input is the whole tool input, with `answers` filled in, not the `answers` list alone. A wrong-length answer list is a 400 the card can show, not a failed row at resume and a generic `tool_input_invalid` the model re-asks past.

## Two schemas, one tool

*Amended after slice 1 (#1017) ran live.* Slice 1 gave the model and the runtime one schema. The model read the optional `answers` key as a field to fill, and the two rules that guard the field then contradicted each other: `askUserInput` refused `answers: []` because the list did not match the question count, and the dispatcher refused the two blank answers the model sent to satisfy that message. Four calls failed in a row and the turn ended with no card. So one `system.ask_user` call now has three schemas:

| Schema | Who reads it | Holds `answers` |
| --- | --- | --- |
| `askUserModelInput` | the model, through `RegisteredTool.modelInputSchema` | no |
| `askUserInput` | the tool runtime: dispatch validation, the resume re-parse, `execute` | yes, with no cross-field rule |
| `askUserDecidedInput` | the decision route, which writes the answers | yes, one entry per question |

`askUserInput` holds no pairing rule on purpose. A stray `answers` must reach the dispatcher's question arm, which names the one repair; a rule on the tool schema would answer first and send the model back to fill the field.

`modelInputSchema` is a general slot on the tool registry, not a special case in the dispatcher. It defaults to `inputSchema`, so every other tool is unchanged, and each model-facing reader takes it instead: the SDK tool surface, the schema budget, the "this tool accepts only these parameters" repair line, the param-key normalizer that renames a casing variant of an accepted key, and the discovery derivation that indexes a tool by its field names. The last two were found by the #1018 review. The normalizer would otherwise rename a model key into the user's field, and discovery would otherwise rank `system.ask_user` against the search word `answers`, which names a field the model cannot write.

Registration proves the subset claim. A tool that declares both schemas must keep every top-level model-facing key inside the runtime schema, or boot refuses it. A model-facing field the runtime rejects would be advertised, filled, and then bounced as an unrecognized key, and the model could not repair it from the surface it was given.

## The settled card reads a preview

The read-only card in the transcript draws from the tool call's result *preview*, not from the stored result. `preview()` prunes a payload that overflows its character budget: strings shorten, arrays slice, and object keys past a limit drop. Pruning cuts `questions` and `answers` to the same length, so a pruned preview still parses and still pairs each question with its own answer. It simply omits whole questions, and no reader can detect that by looking.

So the producer states it. `preview()` returns whether it truncated, and `resultTruncated` rides the tool call through the live event, the durable row, and the synced entity. The card returns nothing for a truncated preview and the turn shows the ordinary tool row instead. A card headed "Your answers" must not hide answers. Measured at three options per question, a three-question call with 120-character descriptions already overflows, so this is the common case for the pager rather than a corner.

The rejected alternative was a `questionCount` field written by the tool and compared against the preview's list length. It made the result schema carry a number only one reader wanted, and it proved one list's length rather than the payload's completeness.

## The gate hint

`toolCallWouldGate` returns `true` for the question arm. The batch dispatcher therefore serializes a question the way it serializes a gated write. A question in the concurrent bucket would park the turn beside a free call whose result the turn cannot receive until the wake.

## Alternatives

- **Gate the tool through `riskTier: "high"`.** Rejected. The `high` floor means "an irreversible action", which a question is not. It would mislabel the email, the card badge, and the run history.
- **A new `question` integration slug.** Rejected. The slug space is the integration registry (ADR-0093). A question is not a connectable provider, and every `system.*` gate would still be needed.
- **An in-process await inside `execute`.** Rejected. The dispatch lease is 60 seconds, there is no tool abort signal, and a worker restart would lose the wait.
- **A separate `questions` table and route.** Rejected. It would duplicate the staging row, the decision route, the expiry worker, and the notification worker for one field.
- **Store the kind on `action_stagings`.** Rejected. The kind is a function of the tool, and the tool is already on the row. The wake already stores it, and no match site needs it.
- **Match the wake by a kind re-derived from the registry.** Rejected after review. The stored wake is authoritative and the derivation was the copy. A registry that had not booted, or a renamed tool, would have answered `wake_mismatch` and left the row pending and the run waiting forever.

## Preserved behavior

Every existing approval kind, wake, decision, and expiry path is unchanged. `resolvePolicyMode` still forces `system.*` to autonomy, and the `high` floor still gates a `system` tool such as `system.activate_workflow`. Sub-agents and background workflows never see the tool. The 24-hour expiry applies to a question as it applies to a write.

## Residual risk

No feature tests. The compiler carries the type widening and the arm table. The boot proof in `registerTool` carries the arm's contract. The `would-gate` mirror suite carries the hint. The runtime parse of the decided input at resume carries the answer shape. The live path from a parked chat turn through the decision route to the resumed tool result was not run end to end in this slice.

Retry suppression matches a byte-identical input hash. A reworded repeat is stopped only by the prose in the `unanswered` message. The only structural cap on a model that rewords after each unanswered result is the chat turn cap, so a run can park up to that many times, 24 hours each, with the composer disabled.

A dismissal goes on the wire as a plain reason-less `reject`. The card types its two decisions as their own union, so a `cancel_run` from a question card and a reason-less write rejection are both uncompilable, but nothing outside the type system separates a dismissal from a write rejection on the route. The route tells them apart by the row's tool name, as every other registry-free reader does.

The tool is lazy and has no prompt guidance until slice #1019, so the boss has little reason to load it in a normal chat today.
