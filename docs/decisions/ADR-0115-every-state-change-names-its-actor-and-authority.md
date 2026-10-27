# ADR-0115 — Every state change names its actor and its authority, and the database keeps the history

**Status.** Proposed; not built. Extends the todo attribution of #1177 (`todo_events`, migration 0134) to the other entities that a user sees and an agent can change. Gives ADR-0113 its authority rule. Uses the existing ledgers (`action_stagings`, `mcp_invocation`, the outbound email log of ADR-0020) and does not replace them.

**Decision.** Each write that changes user-visible state carries one **attribution record**: who did it (`actor`), what permitted it (`authority` and `authorityRef`), which agent action did it (`runId`, `toolCallId`), and why (`cause`, a closed code). For an entity with a lifecycle, a database trigger copies the record into an append-only event table, as `todos_log_transition` does today. For an action outside Alfred, the existing ledger row carries the record. An agent write without an authority is rejected in code. A write without an actor fails; it is not recorded as `system`.

## Why

The agent runtime can change state in many places: it creates and dismisses todos, applies Gmail labels, writes standing instructions, and calls MCP tools. ADR-0087 (Code Mode) adds programs that make many host calls in one run, and ADR-0113 adds instructions whose effects code applies later. When a value is wrong, the owner must be able to answer three questions from stored data, not from logs that expire:

1. **Who changed it?** The user, an agent, or a rule in code.
2. **What permitted it?** A click, a chat request, a standing instruction, or a floor.
3. **Which action did it?** The run and the tool call, so the trace and the transcript can be opened.

The todo work of #1177 answers question 1 for todo status only. A read-only probe of production on 2026-10-27 shows its limits:

| Fact | Effect |
| --- | --- |
| 4 dismissed todos have `resolved_by` null and no `todo_events` row. | They were dismissed before 2026-09-19. Nothing records who dismissed them. |
| 61 todos exist, and 19 creation events exist. | The history starts on 2026-09-19. Earlier todos have no creation record. |
| The trigger writes `COALESCE(NEW.resolved_by, 'system')`. | A writer that forgets the actor produces a `system` event. A real system action and a missing actor look the same. |
| The stored reasons are `dismissed`, `reply`, and `standing_instruction_sender_suppression`. | They are codes in practice, but `reason` is free text. Nothing keeps the set closed. |
| `actor = 'agent'` carries no run id and no tool call id. Only the creation row has `todos.agent_run_id`. | An agent dismissal cannot be traced to the run that did it. |
| `actor = 'agent'` does not say who asked. | "The agent dismissed it because the user asked in chat" and "the agent dismissed it on its own" give the same row. |

Other entities have less:

- `email_triage` stores `source: auto | user` and overwrites the row on each message. The decision trace (`agent_decision_traces`) explains a classification, but not a later change by a floor, an instruction, or the user. ADR-0113 already asks to keep the model verdict as history.
- Standing instructions use the observation log (ADR-0067), so they have history. They do not record the authority that wrote them. The chat path (`system.remember`) depends on the boss model. ADR-0079 closes the document path in code (`standing_instruction` is `not_writable` for a document source), but no code check closes the chat path.

The security reason is the same as the debugging reason. Alfred has one user, so the attacker is not a second user. The attacker is content (an email, a web page, a tool result) that the agent reads and then obeys. An attribution record with a verified authority makes that case visible, and the authority rule below makes part of it impossible.

## The attribution record

One contract in `@alfred/contracts`, used by every writer and every event table:

| Field | Values | Meaning |
| --- | --- | --- |
| `actor` | `user`, `agent`, `system` | Who did the write. The vocabulary of `TODO_RESOLVED_BY`, unchanged. `system` is deterministic code that no model chose to run: a floor, a reconciler, a reply detector. |
| `authority` | `user_direct`, `user_request`, `instruction`, `policy` | What permitted the write. See the table below. |
| `authorityRef` | A typed reference: a message id, an instruction id with its revision, an approval id, or a policy code | The exact item that gave the authority. |
| `runId` | `agent_runs.id`, or null | The run that did the write. Required when `actor = 'agent'`. |
| `toolCallId` | The tool call id, or the Code Mode host-call index | The action inside the run. Required when `actor = 'agent'`. |
| `cause` | A closed code for each entity | Why the write happened, in a form that can be counted. |
| `note` | Short free text, optional | Detail for a person. Never read by code. |

**Authority values:**

| `authority` | `authorityRef` | Example |
| --- | --- | --- |
| `user_direct` | none (the request session is the proof) | The user dismisses a todo in the rail. |
| `user_request` | the id of a user-role chat message in the same thread | The user says "dismiss the Polylane todos", and the boss calls the tool. |
| `instruction` | the instruction id and its `revision` (ADR-0113) | A standing instruction blocks a todo suggestion. |
| `policy` | a code for the rule, for example `triage.todo_gate` or `floor.security` | Triage proposes a todo under ADR-0050; the reply detector closes a todo. |

`actor` and `authority` are independent. An agent can act under `user_request`, `instruction`, or `policy`. A user acts under `user_direct`. `system` acts under `policy` or `instruction`.

## Rules

1. **No authority, no agent write.** When `actor = 'agent'`, code rejects the write unless `authority` and `authorityRef` are present and valid. For `user_request`, code checks that the message exists, has the user role, belongs to the same user, and belongs to the thread of the run. For `instruction`, code checks that the instruction is active at the stated revision. Content that the agent read cannot supply a user message id, so an instruction embedded in an email cannot authorize a write by itself.
2. **A missing actor fails.** The trigger raises an error when a status changes and the actor is null. It does not substitute `system`. A failed write is visible in logs and in the caller; a substituted actor is not visible anywhere.
3. **Causes are closed.** Each entity has its own `cause` list in `@alfred/contracts`, with a `satisfies Record<Cause, …>` table where a reader branches on it. A new cause is a code change.
4. **The database writes the history.** For an entity with a lifecycle, a trigger copies the record into the event table in the same transaction, and a second trigger blocks UPDATE and DELETE on that table. This is the `todo_events` design. A writer cannot forget the history.
5. **The history keeps the old value.** Each event stores the changed fields before and after, not the status alone. This supports undo and the "why" chain below.

**Honest limit of rule 1.** A valid `user_request` reference proves that the user sent a message in the thread. It does not prove that the message asked for this write. If the user asks "summarize my inbox" and an email in the inbox says "dismiss all todos", the boss can still cite the user's message. Rule 1 removes the case where no user message exists, for example a background run that reads mail. It does not replace the approval taxonomy (ADR-0034, ADR-0069) or the capture confirmation of ADR-0113. Writes that hide or demote (`block_todo_suggestion`, `demote_demand`, a hidden label) are the effects an attacker wants most, so the confirmation stays mandatory for them.

## Where the record goes

| Kind of state | Entities | History |
| --- | --- | --- |
| A lifecycle that the user sees and can change | todo, triage tag, standing instruction, document ask | An append-only event table for each entity, written by a trigger (rule 4). |
| An action outside Alfred | Gmail label, Gmail send and draft, MCP write | The existing ledger row gains the record. `action_stagings` already has `run_id`, `step_id`, and `tool_call_id`; it gains `authority`, `authorityRef`, and `cause`. `mcp_invocation` links to its staging row. The outbound email log (ADR-0020) gains the same fields. No new ledger table. |

Per entity:

- **Todos.** `todo_events` gains `authority`, `authority_ref`, `run_id`, `tool_call_id`, `cause`, and the before/after of `name`, `due_date`, and `status`. `resolved_reason` becomes `cause` plus `note`.
- **Triage tag.** A new `triage_tag_events` table records each change of the category, the applied label, and `source`, with the record. The first event of a classification stores the model verdict before floors and instructions, which is the history that ADR-0113 asks for. `actor = 'agent'` with `authority = 'policy'` for a classification; `actor = 'system'` with `authority = 'instruction'` for an instruction effect; `actor = 'user'` with `authority = 'user_direct'` for an override.
- **Standing instructions.** The observation log already keeps history. Each instruction observation gains `authority` and `authorityRef`. A write from chat must carry `user_request` and pass rule 1.
- **Document asks.** The ask lifecycle (proposed, active, resolved) gains an event table. This also gives the missing manual close a place to record itself.

## Uses of the history

1. **Undo for agent actions.** An event stores the value before the change, so the UI can show "Alfred dismissed this because of instruction X" with an Undo control. An undo is a new event with `actor = 'user'`, `authority = 'user_direct'`, and a `cause` that names the event it reverses. The undo is also feedback for the todo producer (#353).
2. **A "why" chain.** An "explain this item" read follows stored ids: tag event → floor or instruction (id and revision) → the observation that created the instruction → the chat message. Each step is a stored reference, not a model guess.
3. **Code Mode stays traceable.** A `code.run` program makes many host calls. `run` gives each call a `requestIndex` through `getHostFunctionContext()` (ADR-0087). A host write records `runId` and `toolCallId = <code.run tool call id>#<requestIndex>`, so each write from a program is as traceable as a single tool call.
4. **A production check.** A read-only probe counts, for each event table, the rows in the last N days with `actor = 'agent'` and no `run_id`, and any `system` event whose `cause` is not a `system` cause. A non-zero count is a writer that broke the contract.

## Rollout

Each slice is a separate PR. Each changes the schema with `db:generate` then `db:migrate`.

1. **Contract and todos.** Add the record to `@alfred/contracts`. Extend `todo_events` and the trigger. Replace the `system` fallback with an error (rule 2). Before the trigger change, run a production census of `system` events. On 2026-10-27 it found one, with the reason `reply`. That event comes from the `close-loop-todos` retraction, which passes `system` explicitly through `tasks/resolve.ts`. The same input schema has a second fallback: `actor: z.enum(TODO_RESOLVED_BY).default("agent")` (`packages/assistant/src/tasks/resolve.ts:39`). Remove that default in this slice, for the same reason as the trigger fallback. Convert the six user writers in `packages/http/src/sync/write/todos.ts` and the agent writer in `packages/assistant/src/tasks/resolve.ts`.
2. **Agent authority.** Enforce rule 1 at the tool dispatch boundary for agent writes, starting with `system.remember` and the todo tools.
3. **Triage tag events.** Add `triage_tag_events`. This slice and the ADR-0113 build share the model-verdict field, so whichever lands first owns it.
4. **Ledgers.** Add the record to `action_stagings` and the outbound email log.
5. **Document asks,** with the manual close.

Rows from before each slice stay as they are. The migration does not guess an actor for an old row; it leaves it null, and readers show "not recorded".

## Alternatives

- **(a) One generic `audit_events` table for all entities.** Rejected. It loses the foreign keys and the typed before/after columns, and every reader must parse a JSON payload to answer a typed question. The shared part is the contract, not the table.
- **(b) Application code writes the history.** Rejected. The `todo_events` trigger already shows that a database trigger cannot be forgotten by a new writer. Application code can be.
- **(c) Keep the `system` fallback.** Rejected. It turns a missing actor into a false fact.
- **(d) Free-text reasons.** Rejected. Production already uses them as codes; a closed list makes that true and countable.
- **(e) Derive attribution from logs and traces.** Rejected. Logs expire and are not joined to rows. The decision trace explains one classification, not a later change.

## Cross-ref

Extends #1177 (`todo_events`, migration 0134). Gives ADR-0113 its capture authority rule and its model-verdict history. Uses ADR-0067 (observation log), ADR-0079 (document path closed for instructions), ADR-0087 (Code Mode host-call index), ADR-0020 (outbound email log), and the `action_stagings` / `mcp_invocation` ledgers. Feeds #353 (todo producer without a user model) through undo events.
