# ADR-0099 — A question is an approval with a different card (amends ADR-0034)

**Decision.** The chat boss asks the user a question with the tool `system.ask_user`. The dispatcher parks the chat turn on the same `wakeCondition.kind='hil'` wake and the same `action_stagings` row that a gated write parks on. The new approval kind `question` is the only difference the run machinery sees. The decision route, the row-version check, the expiry worker, the notification worker, and the Replicache approval queue serve a question unchanged. The kind selects the card and the copy.

Three sub-decisions follow:

1. **A question is an approval with a different card.** Alfred already has one complete human-in-the-loop path (ADR-0034): a staging row, a synced inline card, a decision route with row-version checks, a 24-hour expiry worker, and a debounced email. A question needs every one of those parts and no other part. opencode (`question` tool) and Dimension (`ASK_QUESTIONS` on the same `interrupts` row as write approvals) made the same choice. An in-process wait inside the tool is not possible: the dispatch lease is 60 seconds and a tool has no abort signal.
2. **The `system` autonomy rule forces a fourth staging arm.** `resolvePolicyMode` answers `autonomy` for every `system.*` tool before it reads the user's policy. The only risk tier that still gates under autonomy is `high`, and `high` means an irreversible action. A question is not an irreversible action, so it cannot reach the gate through a risk tier without a false label. The dispatcher gets a fourth arm, `staging: "question"`, next to `staged`, `fast_path`, and `join`. The arm forces `requiresApproval` without a policy read. Boot proves that only one tool declares the arm, that the tool is a `system` tool, that it accepts the question contract, and that it is visible only to the chat boss on a live thread. This mirrors the `join` proof (ADR-0073).
3. **The tool schema carries the answer.** `askUserInput` has an optional `answers` list, one entry per question. The model never fills it; the dispatcher refuses a fresh call that does. The decision route writes the user's answers into the row's `decided_input`. The dispatcher's ordinary resume path re-parses the decided input against the tool schema and runs `execute`, which returns the answers as a normal tool result. No new validation code or new route exists for the answer.

**The kind is derived, not stored.** No column on `action_stagings` holds the approval kind. It lives in `agent_runs.wake_condition` and is derived from the registered tool's staging arm by one function, `approvalKindForTool`. The dispatcher writes the wake with it. The decision route and the expiry worker match with it. `signalRunInTx` therefore cannot answer `wake_mismatch` because two callers spelled the kind by hand.

**Amends ADR-0034.** ADR-0034 named two approval kinds, `step` and `action_staging`. This adds `question` and widens `approvalKindSchema`, the `approval.requested` event, and the signal route to the one enum in `@alfred/contracts`.

---

## What the user sees

The boss calls `system.ask_user` with an optional `context` paragraph and one to four questions. Each question has a text, a short header, two to six options with a label and a description, and a multi-select flag. The turn parks with `status = waiting`. The approval card appears in the chat and in the approvals tray. The composer stays disabled, as it does for a write approval. The user picks options or types a free-text answer and approves. The run wakes. The model receives `{ status: "answered", questions, answers }` and continues the same turn.

In slice 1 the generic approval card with a JSON editor shows the row. The user can approve with `answers` typed in by hand. The ported Dimension card is slice #1018. The tool description and prompt guidance are slice #1019.

## Dismissal and expiry

A rejected row and an expired row both return an `unanswered` result, not a `rejected_by_user` result. The result carries `reason: "dismissed" | "expired"`, the original questions, and a message that tells the model to continue on a stated assumption and not ask the same questions again. Retry suppression for the question arm matches both `rejected` and `expired` rows. For a write, an expired row stays re-proposable, because the user may want the write. For a question, an expired set re-asked on the next step would park the turn on the same silence.

## The gate hint

`toolCallWouldGate` returns `true` for the question arm. The batch dispatcher therefore serializes a question the way it serializes a gated write. A question in the concurrent bucket would park the turn beside a free call whose result the turn cannot receive until the wake.

## Alternatives

- **Gate the tool through `riskTier: "high"`.** Rejected. The `high` floor means "an irreversible action", which a question is not. It would mislabel the email, the card badge, and the run history.
- **A new `question` integration slug.** Rejected. The slug space is the integration registry (ADR-0093). A question is not a connectable provider, and every `system.*` gate would still be needed.
- **An in-process await inside `execute`.** Rejected. The dispatch lease is 60 seconds, there is no tool abort signal, and a worker restart would lose the wait.
- **A separate `questions` table and route.** Rejected. It would duplicate the staging row, the decision route, the expiry worker, and the notification worker for one field.
- **Store the kind on `action_stagings`.** Rejected. The kind is a function of the tool, and the tool is already on the row. A stored copy can drift from the registration.

## Preserved behavior

Every existing approval kind, wake, decision, and expiry path is unchanged. `resolvePolicyMode` still forces `system.*` to autonomy, and the `high` floor still gates a `system` tool such as `system.activate_workflow`. Sub-agents and background workflows never see the tool. The 24-hour expiry applies to a question as it applies to a write.

## Residual risk

No feature tests. The compiler carries the type widening. The boot proof in `registerTool` carries the arm's contract. The `would-gate` mirror suite carries the hint. The runtime parse of the decided input at resume carries the answer shape. The live path from a parked chat turn through the decision route to the resumed tool result was not run end to end in this slice.
