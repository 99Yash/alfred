# State machines

This file lists every status machine in Alfred. For each machine it gives the states, the transitions, the guards, and the invariants. It also lists the invalid transitions that a review found, with a stable ID for each.

## What counts as a state machine

A state machine here is any value that moves through a fixed set of states under writes from more than one place. There are three kinds:

- **Explicit.** A status column with a named state set, for example `agent_runs.status` or `todos.status`. The state set lives in a zod enum or a TypeScript union in `@alfred/contracts`, and sometimes in a DB CHECK.
- **Implicit.** A state that a group of columns encodes, with no status column. Examples are a lease (a timestamp plus an attempt counter), a cursor that only moves forward, a nullable timestamp that means "done", and a "row present means claimed" flag.
- **Client.** A reducer or a hook in `apps/web` that keeps state in memory, for example the chat stream cell or the Replicache lifecycle.

A DB CHECK on a status column enforces membership only. No CHECK in this repo enforces which transitions are legal. Each transition is legal only because its writer uses a guard: a row lock plus a re-check, a compare-and-set (CAS) `WHERE` clause, an advisory lock, or a unique index.

## How to keep this file current

- When you add a writer that changes a status, add its row to the transition table of that machine. Give the trigger, the guard, and the function that writes it.
- When you add a new status column or a new implicit machine, add a row to the index and a section for it.
- When a fix lands for a finding, change only its `Status:` line, for example to `Status: fixed in #1234`. Do not renumber the findings. A new finding takes the next free ID.
- Reference code by repo-relative path and symbol name. Do not write line numbers.

## Index

| Machine                                      | Kind     | Owner module                                                           | DB enforcement                                                                               |
| -------------------------------------------- | -------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `agent_runs.status`                          | explicit | `packages/assistant/src/execution/executor.ts`                         | CHECK (membership); partial unique indexes on dedup key, concurrency key, chat thread, event |
| `agent_steps.status`                         | explicit | `packages/assistant/src/execution/executor.ts`                         | CHECK; unique (run, step, attempt)                                                           |
| Run lease and cancel fence                   | implicit | `packages/assistant/src/execution/executor.ts`                         | none                                                                                         |
| `skill_runs.status`                          | explicit | `packages/assistant/src/skills/revisions.ts`                           | unique run id; no CHECK                                                                      |
| `skills.status`                              | explicit | `packages/assistant/src/skills/revisions.ts`                           | none                                                                                         |
| Workflow last run copy                       | implicit | `packages/assistant/src/execution/run-outcome.ts`                      | none                                                                                         |
| `action_stagings.status` and `outcome`       | explicit | `packages/assistant/src/execution/staged-action.ts`                    | unique (run, tool call); partial unique on unknown outcome; no CHECK                         |
| `chat_messages.status`                       | explicit | `packages/assistant/src/chat/chat-turn-closure.ts`                     | none (conflict rule only)                                                                    |
| Chat turn in-run state                       | implicit | `packages/assistant/src/chat/chat-turn-state.ts`                       | partial unique (one live run per thread)                                                     |
| `chat_attachments.status`                    | explicit | `packages/assistant/src/chat/turn-admission.ts`                        | none (dead states)                                                                           |
| `chat_attachment_representations.status`     | explicit | `packages/assistant/src/chat/attachments/attachment-enrichment.ts`     | primary key                                                                                  |
| Conversation compaction                      | implicit | `packages/assistant/src/chat/compaction/chat-context-store.ts`         | CHECK pairs on watermarks                                                                    |
| `todos.status`                               | explicit | `packages/http/src/sync/write/todos.ts`                                | CHECK; attribution trigger                                                                   |
| `email_triage` row                           | implicit | `packages/assistant/src/triage/store.ts`                               | primary key; category CHECK                                                                  |
| Reply drafting                               | implicit | `packages/assistant/src/reply-drafting/workflow.ts`                    | occurrence unique index                                                                      |
| `document_asks.status`                       | explicit | `packages/assistant/src/connections/document-asks/store.ts`            | CHECK; coherence CHECK; unique source                                                        |
| `artifacts.status`                           | explicit | `packages/assistant/src/artifacts/write.ts`                            | none                                                                                         |
| `briefings.status`                           | explicit | `packages/assistant/src/briefings/store.ts`                            | unique (user, date, slot); no CHECK                                                          |
| `briefing_runs.status`                       | explicit | none (legacy archive)                                                  | partial unique on composed                                                                   |
| `email_sends.status`                         | explicit | `packages/assistant/src/delivery/notify.ts`                            | CHECK; unique (user, idempotency key)                                                        |
| Delivery-alert repeat window                 | implicit | `packages/assistant/src/connections/ingestion/delivery-alert-sweep.ts` | none                                                                                         |
| Shared thread publish and revoke             | implicit | `packages/assistant/src/sharing/shared-threads.ts`                     | unique slug; unique (thread, digest)                                                         |
| `integration_credentials.status`             | explicit | `packages/integrations/src/google/credentials.ts`                      | CHECK; unique (user, provider, account)                                                      |
| `mcp_connections.status` and catalog pointer | explicit | `packages/assistant/src/connections/mcp/manager.ts`                    | composite FK on the pointer; no CHECK                                                        |
| `workflows.status` and `blocked`             | explicit | `packages/assistant/src/automation/revisions.ts`                       | composite FKs on revision pointers; no CHECK                                                 |
| `event_receipts.processing_status`           | explicit | `packages/assistant/src/connections/ingestion/inbound-deliver.ts`      | unique delivery id; no CHECK                                                                 |
| Gmail history cursor                         | implicit | `packages/assistant/src/connections/ingestion/gmail-ingest.ts`         | unique (credential, stream); monotonic SQL upsert                                            |
| `user_facts.status`                          | explicit | `packages/assistant/src/knowledge/facts.ts`                            | none                                                                                         |
| `style_profiles.status`                      | explicit | `packages/assistant/src/knowledge/style-profiles.ts`                   | none                                                                                         |
| `projection_runs.status`                     | explicit | `packages/assistant/src/knowledge/projection.ts`                       | CHECK (status, completed pairs); unique (user, name, version)                                |
| Memory extraction stamp                      | implicit | `packages/assistant/src/knowledge/workflow-operations.ts`              | none                                                                                         |
| Chat stream cell                             | client   | `apps/web/src/lib/chat/chat-stream-state.ts`                           | n/a                                                                                          |
| Live artifact stream                         | client   | `apps/web/src/lib/chat/use-artifact-stream.ts`                         | n/a                                                                                          |
| Composer queue and dispatch                  | client   | `apps/web/src/lib/chat/use-queue-dispatch.ts`                          | n/a                                                                                          |
| Send and pending turn                        | client   | `apps/web/src/lib/chat/use-send-message.ts`                            | n/a                                                                                          |
| Approval card                                | client   | `apps/web/src/components/approvals/use-approval-decision.ts`           | n/a                                                                                          |
| Replicache client lifecycle                  | client   | `apps/web/src/lib/replicache/context.tsx`                              | n/a                                                                                          |
| Replicache push handler                      | client   | `packages/http/src/sync/push.ts`                                       | last mutation id per client                                                                  |
| SSE bus and replay cursor                    | client   | `apps/web/src/lib/events/stream.ts`                                    | n/a                                                                                          |

## Runs and steps

### `agent_runs.status`

States: pending, runnable, running, waiting, deferred (live); completed, failed, cancelled, blocked (terminal). The set is `runStatusSchema` in `packages/contracts/src/agent.ts`.

| From                            | To                     | Trigger                                                       | Guard                                                                                                                                | Where                                          |
| ------------------------------- | ---------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| none                            | pending                | `createRun`                                                   | unique indexes (occurrence, dedup, concurrency, manual, event, chat thread, sub-agent); occurrence conflict returns the existing row | `packages/assistant/src/execution/service.ts`  |
| pending, runnable, due deferred | running                | `leaseRun`                                                    | `FOR UPDATE SKIP LOCKED`; refuses terminal, waiting, future deferred, fresh running                                                  | `packages/assistant/src/execution/executor.ts` |
| running (stale)                 | running (attempt + 1)  | `leaseRun` reclaim                                            | same lock; stale age at or above the step stale window                                                                               | `packages/assistant/src/execution/executor.ts` |
| running (stale, 3 reclaims)     | failed                 | `leaseRun` backstop                                           | same lock                                                                                                                            | `packages/assistant/src/execution/executor.ts` |
| running                         | runnable (attempt + 1) | `commitStepSuccessTx` next                                    | `guardRunOwnership`: attempt equal, cancel generation equal, not terminal                                                            | `packages/assistant/src/execution/executor.ts` |
| running                         | completed              | `commitStepSuccessTx` done                                    | `guardRunOwnership`                                                                                                                  | `packages/assistant/src/execution/executor.ts` |
| running                         | blocked                | `commitStepSuccessTx` blocked                                 | `guardRunOwnership`                                                                                                                  | `packages/assistant/src/execution/executor.ts` |
| running                         | deferred (attempt + 1) | `commitStepSuccessTx` defer                                   | `guardRunOwnership`                                                                                                                  | `packages/assistant/src/execution/executor.ts` |
| running                         | waiting (attempt + 1)  | `commitStepSuccessTx` interrupt                               | `guardRunOwnership`                                                                                                                  | `packages/assistant/src/execution/executor.ts` |
| running                         | failed                 | `commitStepFailure`, `markRunFailed`                          | `guardRunOwnership`                                                                                                                  | `packages/assistant/src/execution/executor.ts` |
| waiting                         | runnable               | `signalRunInTx` (wake, staged action, join wake, HTTP signal) | `FOR UPDATE`; status is waiting; wake matches                                                                                        | `packages/assistant/src/execution/service.ts`  |
| any live                        | cancelled              | `cancelRunInTx` (cancel card, parent cascade)                 | `FOR UPDATE`; not terminal; bumps the cancel generation                                                                              | `packages/assistant/src/execution/service.ts`  |
| running                         | running                | `heartbeatRun` (checkpoint time only)                         | CAS on status running and attempt                                                                                                    | `packages/assistant/src/execution/service.ts`  |

Invariants:

- DB-enforced:
  - Status membership (CHECK).
  - At most one live chat turn per thread, and at most one live run per event identity (partial unique indexes).
  - One row per occurrence, per manual request, and per sub-agent tool call.
  - `agent_runs_dedup_key_idx` holds (user, slug, dedup key) unique while status is not failed or cancelled. A completed or blocked row holds the key for ever, so `dedupKey` means "once only".
  - `agent_runs_concurrency_key_idx` holds (user, slug, concurrency key) unique while status is not terminal. Any terminal row frees the key, so `concurrencyKey` means "one at a time". Learn and skill documentation use it (SM-03).
  - Postgres checks unique indexes in creation order and reports the first one that fails. `AGENT_RUN_UNIQUE_INDEX_MEANING` maps the reported index to duplicate or busy, so the order is part of the contract. A migration may add a unique index on `agent_runs`. It must not drop and re-create one, because that moves the index to the end. `packages/db/test/chat/thread-turn-concurrency.test.ts` pins one case.
- Code-enforced:
  - Terminal is absorbing. Every writer checks `isTerminalStatus` under a row lock, or uses a CAS that matches running only.
  - Only the attempt that leased the run can commit (`guardRunOwnership`).
  - A step that started before a cancel cannot commit (the cancel generation fence).
  - The attempt counter never goes down.
  - Lock order is the run row, then child rows. One known exception: the commit updates `agent_steps` before the guard locks the run. A deadlock then aborts one side (see SM-29).
- Assumed only:
  - A waiting run wakes only through a hil or signal wake. The timer wake kind exists in the schema, but nothing produces it or wakes it. A step that returned a timer wake would park for ever.
  - Sub-agent children never end blocked. `TERMINAL_CHILD_STATUSES` in `packages/assistant/src/execution/sub-agents.ts` omits blocked. This holds only because sub-agents pin no revision.

### `agent_steps.status`

States: running, completed, failed, interrupted, deferred, blocked.

| From    | To                                        | Trigger                        | Guard                                                                      | Where                                          |
| ------- | ----------------------------------------- | ------------------------------ | -------------------------------------------------------------------------- | ---------------------------------------------- |
| none    | running                                   | `tryInsertStepRow`             | unique (run, step, attempt); a conflict skips the step                     | `packages/assistant/src/execution/executor.ts` |
| running | completed, interrupted, deferred, blocked | `commitStepSuccessTx`          | no step predicate; the transaction rolls back if `guardRunOwnership` fails | `packages/assistant/src/execution/executor.ts` |
| running | failed                                    | `commitStepFailure`            | same                                                                       | `packages/assistant/src/execution/executor.ts` |
| running | failed (lease reclaimed)                  | `leaseRun` reclaim or backstop | status is running; run row lock                                            | `packages/assistant/src/execution/executor.ts` |

Invariants:

- DB-enforced: one row per attempt.
- Code-enforced: the backstop counts failed rows with reason lease reclaimed that are newer than the last progress row.
- Assumed only: none found.

### Run lease, cancel fence, and run columns (implicit)

| Columns                                  | Meaning                     | Writers                                                                                    |
| ---------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------ |
| `last_checkpoint_at` + running + attempt | the lease                   | `leaseRun` sets it; `heartbeatRun` refreshes it every 10 s; reclaim after the stale window |
| `cancellation_generation`                | cancel fence                | `cancelRunInTx` only                                                                       |
| `deferred_until`                         | set while deferred          | set on defer, cleared on lease; a cancel leaves it set (harmless)                          |
| `wake_condition`                         | set while waiting           | set on interrupt, cleared on signal and on cancel                                          |
| `started_at`, `ended_at`                 | first lease, terminal write | lease; every terminal write                                                                |
| `outcome`                                | frozen typed outcome        | terminal writes and defer; never cleared when a deferred run resumes (SM-21)               |

A lease holder does not abort its step body on a reclaim. Only commits and `withStepLease` writes are fenced.

### `skill_runs.status` and `skills.status`

`skill_runs.status` is a copy of `agent_runs.status` for the skill History card. Values in use: running, completed, failed, cancelled. The default pending is never written. `skills.status` is draft or active.

| From        | To                | Trigger                                                         | Guard                                             | Where                                                  |
| ----------- | ----------------- | --------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------ |
| none        | running           | `recordSkillRun`                                                | conflict on the agent run id does nothing         | `packages/assistant/src/skills/revisions.ts`           |
| running     | completed         | learn persist step body, before the run commits                 | CAS on status not terminal                        | `packages/assistant/src/skills/learn-skill.ts`         |
| running     | failed, cancelled | workflow terminal closure after the commit (`finalizeSkillRun`) | same CAS; `driveClosure` logs and swallows errors | `packages/assistant/src/execution/terminal-closure.ts` |
| skill draft | skill active      | first distilled revision                                        | transaction; revision conflict skips the pointer  | `packages/assistant/src/skills/revisions.ts`           |

Invariants:

- DB-enforced: one `skill_runs` row per agent run.
- Code-enforced: the terminal CAS stops a second terminal write.
- Assumed only: the copy equals the agent run status when terminal. It can drift (SM-20).

### Workflow last run copy (implicit)

`recordWorkflowLastRun` in `packages/assistant/src/execution/run-outcome.ts` is the single writer of the last run id, time, and `last_run_status`. It runs in the same transaction as every terminal status write, so a superseded commit rolls it back. It has no ordering predicate: the last run to finish wins (SM-33).

### Run queues

- The agent run queue in `packages/assistant/src/execution/queue.ts` has step jobs and keyed start jobs. Any number of jobs can exist for one run. The DB lease decides who runs. A resume sweep re-enqueues pending, runnable, due deferred, and stale running runs every 30 s.
- The sub-agent join wake queue in `packages/assistant/src/execution/sub-agent-join-wake-queue.ts` holds one delayed job per child at the 6-minute ceiling. A 60 s reconciler in `packages/assistant/src/execution/sub-agent-join-wake-worker.ts` backs it up.
- The approval expiry job and its 5-minute reconciler in `packages/assistant/src/execution/approval-expiry-worker.ts` go through `expireStagedAction`, which locks the run, then the staging.

## Approvals and chat

### `action_stagings.status` and `outcome`

States: pending, approved, rejected, expired, executed, failed. The companion `outcome` has the values planned, awaiting_approval, dispatching, succeeded, failed, unknown, superseded, compensated, refused. Other companion columns: `requires_approval` (a gated pending row is a card; an ungated pending row is runnable), `dispatch_claimed_at` (set with no result means "may have run"), and `row_version` (the client CAS token).

| From                        | To                                | Trigger                                   | Guard                                                                                              | Where                                                                    |
| --------------------------- | --------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| none                        | pending (awaiting or dispatching) | `upsertStaging`                           | conflict on (run, tool call) is a no-op that returns the stored row; a terminal row is not revived | `packages/assistant/src/tool-runtime/internal/dispatch/staging-store.ts` |
| pending ungated             | pending gated                     | `promotePendingApproval`                  | status pending and not gated                                                                       | `packages/assistant/src/tool-runtime/internal/dispatch/staging-store.ts` |
| pending gated               | approved (dispatching)            | `decideStagedAction` approve              | run lock, then staging lock; status pending; row version matches; `wakeRunInTx` must wake the run  | `packages/assistant/src/execution/staged-action.ts`                      |
| pending gated               | pending gated (restaged)          | `decideStagedAction` restage              | same locks and version check; the run is not woken                                                 | `packages/assistant/src/execution/staged-action.ts`                      |
| pending gated               | rejected (refused)                | `decideStagedAction` reject               | same as approve                                                                                    | `packages/assistant/src/execution/staged-action.ts`                      |
| pending gated               | rejected (refused)                | `cancelRunInTx`                           | run `FOR UPDATE`, run not terminal; status pending and gated                                       | `packages/assistant/src/execution/service.ts`                            |
| pending gated               | rejected (refused)                | `rejectLateCancelledRunStagings`          | run is cancelled; status pending and gated                                                         | `packages/assistant/src/execution/service.ts`                            |
| pending gated               | rejected (refused)                | `withdrawToolCallApproval`                | run `FOR UPDATE` and running; step and attempt match                                               | `packages/assistant/src/tool-runtime/approval-lifecycle.ts`              |
| pending gated               | expired (refused)                 | `expireStagedAction` (job and reconciler) | same locks as decide; expiry time passed; run woken on this approval                               | `packages/assistant/src/execution/staged-action.ts`                      |
| approved or pending ungated | same, claimed                     | `claimDispatch`                           | `withStepLease`; runnable and not yet claimed                                                      | `packages/assistant/src/tool-runtime/internal/dispatch/staging-store.ts` |
| claimed                     | pending gated ("may have run")    | `restageInterrupted`                      | step lease; runnable and claimed                                                                   | `packages/assistant/src/tool-runtime/internal/dispatch/staging-store.ts` |
| approved or pending ungated | executed, failed                  | `commitStaging`                           | CAS on (status, outcome) and on the claim time; or an idempotent refill                            | `packages/assistant/src/tool-runtime/internal/dispatch/staging-store.ts` |
| approved (dispatching)      | executed, failed                  | `settleMcpInvocationAggregate`            | outcome is dispatching; invocation guards in the same transaction                                  | `packages/assistant/src/tool-runtime/mcp/broker.ts`                      |
| several                     | executed (unknown)                | `markMcpSettlementIncomplete`             | outcome in a list; invocation state                                                                | `packages/assistant/src/tool-runtime/mcp/broker.ts`                      |

The MCP recovery path also resolves an unknown outcome and inserts a successor row under the run, connection, invocation, and staging locks. The approval notification worker stamps `notified_at` and bumps `row_version` (SM-24).

Invariants:

- DB-enforced: unique (run, tool call). Partial unique (user, request hash) where the outcome is unknown. The run FK cascades on delete.
- Code-enforced:
  - A human decision and an expiry are serialized. Both lock the run, then the staging, re-check pending, and refuse unless the run wakes on this exact approval. Approve against expire, approve twice from two tabs, approve against cancel, and decide against withdraw are all safe.
  - The upsert never touches decision or result columns.
  - A zombie commit cannot write after a restage, because `commitStaging` fences on the claim time.
  - A cancel is followed by late-staging sweeps in the cancel path and in the losing executor.
- Assumed only:
  - Status and outcome agree. No CHECK pairs them, so each writer sets both. The cancel sweeps did not (SM-05).
  - A pending gated row belongs to a run that is, or will be, waiting on it. A failed run breaks this (SM-19). A thread delete cancels the live runs of that thread after the push commits (`cancelDeletedThreadRuns`), which rejects their pending rows (SM-14). A crash between the commit and that cancel still breaks it.

### `chat_messages.status`

States: complete, failed. An absent row means "streaming". The row is written only at the terminal point.

| From   | To                   | Trigger                                   | Guard                                                        | Where                                              |
| ------ | -------------------- | ----------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------- |
| none   | complete (user turn) | `startChatTurn`, `chatMessageCreate` push | conflict does nothing                                        | `packages/assistant/src/chat/turn-admission.ts`    |
| none   | complete (assistant) | `upsertCompletedRow`                      | `withStepLease` for a step body; none for the cancel closure | `packages/assistant/src/chat/chat-turn-closure.ts` |
| failed | complete             | `upsertCompletedRow`                      | update only where the row is failed                          | `packages/assistant/src/chat/chat-turn-closure.ts` |
| none   | failed               | `insertFailedRow`                         | conflict does nothing, so a late fault never demotes a row   | `packages/assistant/src/chat/chat-turn-closure.ts` |

Invariants:

- DB-enforced: complete to failed cannot happen, because of the conflict rule.
- Code-enforced: a completed close does nothing after a cancel; the step lease fences on the cancel generation. The error kind is set only when the row is failed.
- Assumed only: none found. No invalid transition was found.

### Chat turn in-run state (implicit)

The run steps are chat turn, then dispatch tools, then chat turn, park, or done. The checkpoint in `packages/assistant/src/chat/chat-turn-state.ts` holds the start time, the park time and park kind (join or gate, set by `interruptChatRun`, cleared by `foldResumedPark`), the pending tool calls, the reissue flag, and the retry counters.

The stop flag is a Redis key with a 15-minute TTL in `packages/assistant/src/chat/stop-signal.ts`. `stopChatTurn` sets it and refuses terminal and waiting runs. The stream poll, the capacity backoff, and each tool batch read it. When the dispatch tools step resumes from a gate park, it deletes the flag (`clearChatStop`) before its stop check, so the user's decision outranks an earlier Stop. A join park keeps the flag.

Invariants:

- DB-enforced: one live run per thread; a dedup key per user message for non-failed, non-cancelled runs.
- Code-enforced: admission maps a unique violation to busy or reuse inside a savepoint. A Stop pressed before an approval park does not survive the decision (SM-08).
- Assumed only: a Stop pressed during the first attempt of a resumed step applies. A worker reclaim of that step clears the flag again, so it does not. A Reject or an expiry after a Stop before the park also clears the flag, so the model writes its follow-up.

### `chat_attachments.status` and representations

`chat_attachments.status` has the states pending, ready, failed. The only writer is the insert in `startChatTurn`, and `toAttachmentRow` always writes ready. Pending and failed are dead states. This is not a live machine.

`chat_attachment_representations.status`:

| From            | To      | Trigger                                 | Guard                     | Where                                                              |
| --------------- | ------- | --------------------------------------- | ------------------------- | ------------------------------------------------------------------ |
| none            | pending | `claimChatAttachmentEnrichment`         | conflict does nothing     | `packages/assistant/src/chat/attachments/attachment-enrichment.ts` |
| pending, failed | ready   | `persistChatAttachmentRepresentation`   | status in pending, failed | `packages/assistant/src/chat/attachments/attachment-enrichment.ts` |
| pending         | failed  | `recordChatAttachmentEnrichmentFailure` | status is pending         | `packages/assistant/src/chat/attachments/attachment-enrichment.ts` |

Invariants: the primary key is (attachment, representation version). Assumed only: a claimed row always gets a job. A crash between the claim and the enqueue breaks this (SM-28).

### Conversation compaction (implicit)

A thread is "compacting" when the request time is later than both the completion time and the failure time. The summary has its own generation counter.

| Change                                          | Writer                                | Guard                                    | Where                                                          |
| ----------------------------------------------- | ------------------------------------- | ---------------------------------------- | -------------------------------------------------------------- |
| request time set                                | `markConversationCompactionRequested` | upsert                                   | `packages/assistant/src/chat/compaction/chat-context-store.ts` |
| failure time set                                | `recordConversationCompactionFailure` | CAS on generation and request time       | `packages/assistant/src/chat/compaction/chat-context-store.ts` |
| replay estimate advanced                        | `persistConversationReplayEstimate`   | CAS on generation and estimate watermark | `packages/assistant/src/chat/compaction/chat-context-store.ts` |
| summary written, completion set, generation + 1 | `persistConversationSummary`          | CAS on generation and summary watermark  | `packages/assistant/src/chat/compaction/chat-context-store.ts` |

Invariants: DB CHECKs pair each watermark. Code CASes keep the watermark from moving back. Assumed only: every background job ends with a completion or a failure write. A nothing_to_compact result breaks this (SM-27).

## Todos, triage, drafting, artifacts

### `todos.status`

States: suggested, open, done, dismissed, cleared. `LIVE_TODO_STATUSES` is suggested and open. Companion columns: the completion time (set while done, kept on cleared), the one-shot attribution, and the update time, which drives the 30-day re-suggest window.

| From            | To                       | Trigger                                                                                     | Guard                                                                              | Where                                     |
| --------------- | ------------------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------- |
| none            | open                     | `todoCreate` push                                                                           | conflict on id does nothing                                                        | `packages/http/src/sync/write/todos.ts`   |
| none            | suggested                | `suggestTodo`                                                                               | transaction and per-user advisory lock when sources exist; merge or suppress first | `packages/assistant/src/tasks/suggest.ts` |
| live            | same, sources merged     | `suggestTodo` merge                                                                         | advisory lock (suggest only); no status guard on the update                        | `packages/assistant/src/tasks/suggest.ts` |
| open            | done                     | `todoComplete`                                                                              | status is open                                                                     | `packages/http/src/sync/write/todos.ts`   |
| suggested       | done                     | `todoCompleteSuggestion`                                                                    | status is suggested                                                                | `packages/http/src/sync/write/todos.ts`   |
| done            | open                     | `todoReopen`                                                                                | status is done                                                                     | `packages/http/src/sync/write/todos.ts`   |
| suggested       | open                     | `todoPromote`                                                                               | status is suggested                                                                | `packages/http/src/sync/write/todos.ts`   |
| suggested, open | dismissed                | `todoDismiss`                                                                               | status is live                                                                     | `packages/http/src/sync/write/todos.ts`   |
| done            | cleared                  | `todoClear`                                                                                 | status is done                                                                     | `packages/http/src/sync/write/todos.ts`   |
| any             | same (name, description) | `todoEdit`                                                                                  | owner only                                                                         | `packages/http/src/sync/write/todos.ts`   |
| suggested, open | dismissed                | `resolveTodosForGmailSource` (reply close-loop, payment match, resolve by sender or thread) | per-status CAS on the ids matched in each status                                   | `packages/assistant/src/tasks/resolve.ts` |
| suggested, open | dismissed                | `resolveTodosByIds`                                                                         | status is live                                                                     | `packages/assistant/src/tasks/resolve.ts` |

Invariants:

- DB-enforced: status membership (CHECK). The attribution trigger raises unless each status change carries a valid attribution. Identity columns cannot change. Identity source refs and the todo event log are append-only. The DB does not enforce legal transitions; the trigger only logs them.
- Code-enforced: every server transition is a CAS on the source status, so a Replicache redelivery is a no-op. System retraction for a reply or a payment touches suggested rows only. `suggestTodo` serializes on the per-user advisory lock and merges, so at most one live todo exists per identity. No unique index backs this. `suggestTodo` suppresses a new suggestion for 30 days after a done, dismissed, or cleared todo with the same identity (SM-06).
- Assumed only: done means the completion time is set. A merge target is still live when the merge update runs (SM-34).

Client and server guards differ in two places, both benign. The client `todoComplete` accepts suggested, but the UI sends `todoCompleteSuggestion` for suggestions. The client `todoDismiss` deletes a row in any status, but the server dismisses only live rows, so a done row flickers and then comes back on rebase.

### `email_triage` row (implicit)

The row has a source (auto or user). The override time is set only when the source is user. The applied label id is null (Gmail may lag) or set (confirmed). The newest message owns the row through its document id. The cached effective result lives in the category, document ask, todo suggestion, and todo decision columns.

| Change                             | Writer                                           | Guard                                                                                                                                      | Where                                         |
| ---------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| none or auto to auto (new verdict) | `upsertTriage`                                   | thread advisory lock; skip if the stored document is newer                                                                                 | `packages/assistant/src/triage/store.ts`      |
| user to user (newer message)       | `upsertTriage`                                   | thread advisory lock; the stored document is older; writes the evaluation and keeps the category, source, override time, and applied label | `packages/assistant/src/triage/store.ts`      |
| auto to user                       | `triageTagOverride` push                         | none (user always wins); clears the applied label                                                                                          | `packages/http/src/sync/write/triage-tags.ts` |
| user to auto                       | none (user is absorbing)                         | none                                                                                                                                       | none                                          |
| auto to auto (re-match)            | `updateTriageEvaluation`                         | thread lock, `FOR UPDATE`, update re-checks source and document                                                                            | `packages/assistant/src/triage/store.ts`      |
| applied label set                  | `setAppliedLabelId`, `setTriageReconciledTarget` | caller holds the thread lock; no check on category or source                                                                               | `packages/assistant/src/triage/store.ts`      |

Invariants: the primary key gives one row per (user, thread). A classify or re-match never changes the category of a user override; the guarded writes re-check the latest row. The side effects of a classify (todo mint, classified event, inbox update) run only when the row was written. A user retag pins only the category: a newer message on a pinned thread still writes its evaluation, so its todo and reply draft follow the model's verdict for that message (SM-09). A re-run of the pinned message and an older message write nothing.

### Reply drafting (implicit)

There is no table. The state lives in the run state in `packages/assistant/src/reply-drafting/workflow.ts`: gate, gather, compose, stage, a human interrupt, then a terminal result (no draft, no access, withheld, staged). The draft is an `action_stagings` approval row.

Invariants: one run per (thread, document) through the occurrence unique index. One staged body per run, through a fixed tool call id. The gate runs again before the first staging and requires that the triage row still points at the run's document. A terminal step withdraws its pending approval. Assumed only: a staged draft stays current. A newer message does not withdraw it (SM-23).

### `document_asks.status`

States: active, resolved.

| From   | To       | Trigger           | Guard                                           | Where                                                       |
| ------ | -------- | ----------------- | ----------------------------------------------- | ----------------------------------------------------------- |
| none   | active   | `createIfAbsent`  | unique source identity; conflict does nothing   | `packages/assistant/src/connections/document-asks/store.ts` |
| active | resolved | `resolveIfActive` | CAS on active, identity, and kind in one update | `packages/assistant/src/connections/document-asks/store.ts` |

Invariants: DB CHECKs enforce membership, resolution coherence (all resolution columns null while active, all set when resolved), and kind equality. Resolved is absorbing. Two active asks of one kind on one thread is a dead state (SM-30).

### `artifacts.status`

States: generating, complete, error. There is no DB CHECK.

| From       | To              | Trigger                                         | Guard                                                         | Where                                              |
| ---------- | --------------- | ----------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------- |
| none       | generating      | `createArtifact`, `surfaceExternalFileArtifact` | none                                                          | `packages/assistant/src/artifacts/write.ts`        |
| generating | complete, error | `finalizeRunArtifacts` (turn closure)           | matches the creating run id, the from-statuses, and a message | `packages/assistant/src/artifacts/write.ts`        |
| error      | complete        | cancel closure                                  | from generating or error                                      | `packages/assistant/src/chat/chat-turn-closure.ts` |
| any        | same (content)  | `updateArtifact`, page and markdown appends     | row `FOR UPDATE`; a cross-run full replace needs a base hash  | `packages/assistant/src/artifacts/write.ts`        |
| error      | complete        | `updateArtifact` full replace by a later run    | row `FOR UPDATE`; base hash matches                           | `packages/assistant/src/artifacts/write.ts`        |

Invariants: finalize moves the status for the creating run only. A full replacement by a later run moves error to complete (SM-07). A rename, an exact-match edit, or an append never changes the status. Assumed only: every artifact leaves generating. No reaper exists, and the run FK is set null on delete, so a row whose run is gone before finalize stays generating. A complete artifact that a later failing turn appends to stays complete.

Notes have no state machine. The only writer is the `noteCreate` insert.

## Briefings and delivery

### `briefings.status`

States: pending, gathering, composing, composed, sent, suppressed, failed. This is a TypeScript union with no DB CHECK. Companion columns: `send_decision`, the watermark (set at composed, then again at sent or suppressed), `email_send_id`, and the prose fields. `updateBriefing` in `packages/assistant/src/briefings/store.ts` updates by id with no status guard.

| From                                    | To                               | Trigger                                                                                | Guard                                                                  | Where                                                     |
| --------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------- |
| none                                    | pending                          | `beginBriefing` insert                                                                 | conflict on (user, date, slot) does nothing                            | `packages/assistant/src/briefings/store.ts`               |
| sent, suppressed                        | no write (skip)                  | `beginBriefing`                                                                        | read after the conflict                                                | `packages/assistant/src/briefings/store.ts`               |
| failed                                  | pending (fields wiped)           | `beginBriefing` retry                                                                  | none (read, then update)                                               | `packages/assistant/src/briefings/store.ts`               |
| pending, gathering, composing, composed | same (resume; stamps the run id) | `beginBriefing`                                                                        | only when the stored run id differs                                    | `packages/assistant/src/briefings/store.ts`               |
| any                                     | gathering                        | `markBriefingGathering`                                                                | none                                                                   | `packages/assistant/src/briefings/workflow-operations.ts` |
| gathering                               | suppressed                       | quiet morning cron                                                                     | morning slot, cron reason, quiet day, not a dry run                    | `packages/assistant/src/briefings/workflow-operations.ts` |
| any                                     | composing                        | `markBriefingComposing`                                                                | none                                                                   | `packages/assistant/src/briefings/workflow-operations.ts` |
| composing                               | composed                         | `markBriefingComposed`                                                                 | none                                                                   | `packages/assistant/src/briefings/workflow-operations.ts` |
| any                                     | failed                           | gather or compose error, open-ask block, notify failed (`markBriefingFailed`)          | none                                                                   | `packages/assistant/src/briefings/workflow-operations.ts` |
| composed                                | sent                             | `markBriefingSent` (also on a duplicate send)                                          | none                                                                   | `packages/assistant/src/briefings/workflow-operations.ts` |
| pending, gathering, composing           | failed                           | run ends failed or cancelled outside the step: terminal closure (`failBriefingForRun`) | the run owns the row (`agent_run_id`); status re-checked in the update | `packages/assistant/src/briefings/store.ts`               |

Runs start from the hourly tick (`packages/assistant/src/briefings/worker.ts`, one occurrence key per tick time) and from the manual endpoint in `packages/http/src/me.ts`. The endpoint blocks sent, suppressed, pending, gathering, and composing rows, lets composed and failed through, and has a 60 s Redis throttle that fails open. Each manual request gets its own request id in `enqueueBriefingRun`, so a retry after a failed run starts a new run (SM-04).

Invariants:

- DB-enforced: one row per (user, date, slot). The watermark index is partial on sent and suppressed, but it is an index, not a constraint.
- Code-enforced: terminal rows are never composed again. Only sent and suppressed rows move the next window. A crash after the email row is sent but before `markBriefingSent` heals on re-run, because `notify` returns duplicate. A run that ends failed or cancelled leaves the row that it owns failed, not live; a composed row stays for a later run to send (SM-11).
- Assumed only: at most one live run per (user, date, slot). Status, slot, and send decision values are valid. The run state parses with `stateSchema`; if it does not, the closure is skipped and the row stays live.

`briefing_runs.status` (composing, composed, failed) is a legacy archive with no writer. Meeting prep is designed, not built, and has no machine yet.

### `email_sends.status`

States: queued, sent, failed. The sent time and provider message id are set only when sent.

| From           | To                     | Trigger                                                       | Guard                                         | Where                                       |
| -------------- | ---------------------- | ------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------- |
| none           | queued                 | `notify` insert                                               | unique (user, idempotency key)                | `packages/assistant/src/delivery/notify.ts` |
| queued, failed | queued (error cleared) | `notify` upsert                                               | conflict update only where status is not sent | `packages/assistant/src/delivery/notify.ts` |
| sent           | no write (duplicate)   | `notify`                                                      | the upsert returns no row                     | `packages/assistant/src/delivery/notify.ts` |
| queued         | sent                   | the provider accepts, or answers `invalid_idempotent_request` | status is not sent                            | `packages/assistant/src/delivery/notify.ts` |
| queued         | failed                 | the send throws, or the provider returns another error        | status is not sent                            | `packages/assistant/src/delivery/notify.ts` |
| queued         | no write (duplicate)   | the provider answers `concurrent_idempotent_requests`         | the other caller owns the outcome             | `packages/assistant/src/delivery/notify.ts` |

Callers: the daily briefing, the legacy briefing, the delivery-alert sweep, the approval worker, the workflow-blocked email, the skill documentation email, and the drift health alert.

Invariants:

- DB-enforced: status and kind CHECKs; one row per idempotency key.
- Code-enforced: Alfred never sends a sent row again. Sent is terminal: the sent and failed updates skip a sent row. A failed write of sent after a delivered send throws for a retry and does not record failed (SM-02).
- Assumed only: a retry body differs, because every email shell prints a "Generated on" minute and alert copy is model-written per call. The provider then answers `invalid_idempotent_request`, and `notify` reads that as proof that the first send landed. There is no claim token on queued, so a second caller can take a live queued row.

### Delivery-alert repeat window (implicit)

Per (user, subject), the states are healthy, broken and not alerted, alerted (a sent row in the last 7 days), and back to broken and not alerted when the window ends. The sweep in `packages/assistant/src/connections/ingestion/delivery-alert-sweep.ts` runs every 6 hours. `listRecentAlertKeys` counts only sent rows, and the match is by key prefix, so a timezone change still silences. A failed alert throws, and BullMQ retries the whole sweep. Code invariant: at most one recorded-sent alert per subject per 7 days. Recovery is not tracked, by design.

### Shared thread publish and revoke (implicit)

States: absent, published (a row), revoked (hard delete). `shareThread` reads an existing row by (thread, snapshot digest) or inserts one; `revokeSharedThread` deletes it. DB-enforced: unique slug and unique (thread, digest), so concurrent publishes converge. A publish after a revoke mints a new slug. A share and revoke race can return a dead link (SM-46).

## Connections, workflows, ingestion, memory

### `integration_credentials.status`

States: active, needs_reauth. A deleted row is the implicit third state.

| From   | To                       | Trigger                                  | Guard                                              | Where                                                                    |
| ------ | ------------------------ | ---------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------ |
| none   | active                   | `upsertIntegrationCredential` (connect)  | unique index and conflict                          | `packages/integrations/src/shared/credential-upsert.ts`                  |
| any    | active (tokens replaced) | same upsert, conflict branch (reconnect) | the conflict update waits for a refresh row lock   | `packages/integrations/src/shared/credential-upsert.ts`                  |
| active | active (tokens rotated)  | token refresh                            | transaction, `FOR UPDATE` re-read, expiry re-check | `packages/integrations/src/google/credentials.ts`                        |
| active | needs_reauth             | refresh gets a reauth error              | same lock; returns so the transaction commits      | `packages/integrations/src/google/credentials.ts`                        |
| any    | none                     | disconnect, `deleteCredential`           | transaction scoped to owner and provider           | `packages/assistant/src/runtime/adapters/google-credential-lifecycle.ts` |

Invariants: DB CHECK and unique (user, provider, account). Two refreshes cannot both call Google; the row lock serializes them. A refresh cannot overwrite a reconnect, because the refresh re-reads under the lock. Keep that re-read. OAuth callback replay fails on the second Redis nonce read. No invalid transition was found. A watch install that races a disconnect leaves a remote channel alive until it expires (at most 7 days); pushes for the deleted credential are dropped.

### `mcp_connections.status` and catalog pointer

States: disconnected, connecting, ready, stale, auth_required, failed. There is no DB CHECK. A composite FK ties `current_catalog_revision_id` to the connection's own revision. Readers gate on the pointer, not on the status. The in-memory `McpConnectionManager` keeps one generation per connection per process.

| From                             | To                          | Trigger                                     | Guard                                                                | Where                                                       |
| -------------------------------- | --------------------------- | ------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------- |
| none                             | disconnected, auth_required | `ensureConnection` insert                   | unique (user, server, instance key)                                  | `packages/assistant/src/connections/mcp/persistence.ts`     |
| any                              | connecting                  | client start                                | uninterruptible write; no check on the value                         | `packages/assistant/src/connections/mcp/manager.ts`         |
| any                              | connecting                  | post-consent transport retry                | none                                                                 | `packages/http/src/mcp.ts`                                  |
| connecting, stale                | ready (pointer set)         | catalog activation                          | CAS on the expected pointer                                          | `packages/assistant/src/connections/mcp/manager.ts`         |
| ready                            | stale (pointer null)        | list-changed event                          | CAS on the pointer                                                   | `packages/assistant/src/connections/mcp/manager.ts`         |
| any                              | failed (pointer null)       | start failure or refresh failure            | CAS on the pointer                                                   | `packages/assistant/src/connections/mcp/manager.ts`         |
| any, pointer null                | failed                      | GitHub App grant adopt cannot store grant   | CAS on a null pointer; a catalog wins                                | `packages/assistant/src/connections/mcp/manager.ts`         |
| any                              | disconnected, connecting    | GitHub App grant adopt (an owner connect)   | grant stored under the refresh lock first                            | `packages/assistant/src/connections/mcp/manager.ts`         |
| any                              | auth_required               | start needs consent; client OAuth callbacks | none for the callbacks (ADR-0114 residual risk)                      | `packages/assistant/src/connections/mcp/manager.ts`         |
| ready, stale                     | auth_required               | keep-alive: dead grant, or 72 h of failures | CAS: status ready or stale, same credential, same `lastAuthorizedAt` | `packages/assistant/src/connections/mcp/manager.ts`         |
| connecting, ready, stale, failed | auth_required               | migration 0167, one time                    | GitHub built-in; grant has no access token                           | `packages/db/src/migrations/0167_github_mcp_app_client.sql` |
| any                              | disconnected (pointer null) | disconnect                                  | none, after the scope closes                                         | `packages/assistant/src/connections/mcp/manager.ts`         |
| failed                           | previous status and pointer | reconnect failure restore                   | none                                                                 | `packages/assistant/src/connections/mcp/manager.ts`         |
| row                              | none                        | remove                                      | `FOR UPDATE`, gate, and a removal fence                              | `packages/assistant/src/connections/mcp/persistence.ts`     |

Invariants: one live generation per connection per process; admission refuses while a generation is closing or being removed. A stale worker cannot move the pointer (CAS). MCP token refreshes are serialized by an advisory lock with a locked re-read. The recovery loop never revives disconnected or auth_required rows. The keep-alive refreshes only ready and stale grants, because a token save clears `lastError`. Its auth_required write is a CAS on the grant that the verdict read (`lastAuthorizedAt`), so a disconnect, a reconnect, or a newer grant wins. A newer grant is a consent or a GitHub App adopt that saved its tokens after the refresh lock was released. An owner connect re-opens a disconnected connection: reconnect, the consent callback, and the GitHub App grant adopt (ADR-0093 amendment 2026-11-12). Assumed only: no other path re-opens one (SM-12); the consent callback and a refresh do not overlap (SM-13).

### `workflows.status`, `blocked`, and revision pointers

States: draft, active, paused, archived. There is no DB CHECK. `blocked` is a nullable verdict with a notified sub-phase. The current and published revision pointers have composite FKs to the workflow's own revisions. `next_run_at` is the scheduler phase.

| Change                                            | Writer                       | Guard                                                                  | Where                                                               |
| ------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------- |
| none to draft (revision 1)                        | `createWorkflowDraft`        | transaction; slug conflict                                             | `packages/assistant/src/automation/revisions.ts`                    |
| current pointer moves                             | `reviseWorkflow`             | row version CAS; unique revision number                                | `packages/assistant/src/automation/revisions.ts`                    |
| any to active, block cleared, published set       | `activateWorkflow`           | row version CAS; readiness in the transaction; expected content hash   | `packages/assistant/src/automation/revisions.ts`                    |
| approval card to active                           | `activateWorkflowDefinition` | locked stale check on base revision and hash, then the row version CAS | `packages/assistant/src/automation/revisions.ts`                    |
| any to paused, draft, archived (next run cleared) | `setWorkflowStatus`          | optional row version CAS                                               | `packages/assistant/src/automation/revisions.ts`                    |
| block set or cleared                              | `reconcileWorkflowReadiness` | caller transaction; the runtime path holds `FOR UPDATE`                | `packages/assistant/src/automation/runtime-readiness.ts`            |
| block notified time                               | blocked notification worker  | JSON equality CAS                                                      | `packages/assistant/src/execution/workflow-blocked-notification.ts` |
| next run advanced                                 | cron tick claim              | CAS on the next run time                                               | `packages/assistant/src/automation/tick.ts`                         |
| last run fields                                   | `recordWorkflowLastRun`      | inside the run's guarded commit                                        | `packages/assistant/src/execution/run-outcome.ts`                   |

Invariants: an edit cannot clear a block on a published revision. Activation of a stale revision fails on three checks. A pause clears the next run time, so the tick CAS loses. Assumed only: the tick does not re-check the block at claim time; the run's readiness check then defers or blocks it. Every block write, notification stamp, and last-run write bumps the row version, so a background run can turn an open edit form into a row version conflict.

### `event_receipts.processing_status`

States: pending, completed, failed (TypeScript type only).

| From            | To              | Trigger                       | Guard                                           | Where                                                                    |
| --------------- | --------------- | ----------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------ |
| none            | pending         | webhook receive               | dedup unique on (provider, delivery id)         | `packages/assistant/src/connections/ingestion/inbound-receive.ts`        |
| pending, failed | completed       | `deliverInboundReceipt`       | BullMQ job id per receipt; completed is a no-op | `packages/assistant/src/connections/ingestion/inbound-deliver.ts`        |
| pending         | failed          | unknown type or publish error | none                                            | `packages/assistant/src/connections/ingestion/inbound-deliver.ts`        |
| completed       | payload cleared | payload reaper                | row lock and status re-check                    | `packages/assistant/src/connections/ingestion/receipt-payload-reaper.ts` |

Gmail receipts never leave pending; for Gmail the column has no meaning. A webhook receipt whose enqueue failed stays pending with no sweeper. Activity coverage detects the missing act and replays it, by design.

### Gmail history cursor (implicit)

The cursor is the history id in the ingestion state row for each (credential, stream). `upsertIngestionState` in `packages/assistant/src/connections/ingestion/gmail-ingest.ts` is a monotonic compare-and-advance in SQL, so the cursor never moves back (ADR-0037). `seedGmailHistoryCursorIfAbsent` never resets it.

| From | To                                                                                 | Trigger                             | Guard                 | Where                                                          |
| ---- | ---------------------------------------------------------------------------------- | ----------------------------------- | --------------------- | -------------------------------------------------------------- |
| none | seeded                                                                             | `seedGmailHistoryCursorIfAbsent`    | insert only if absent | `packages/assistant/src/connections/ingestion/gmail-ingest.ts` |
| H    | max history id of fetched messages; H when a fetch failed or the list hit the cap  | `pollGmailRecent` (realtime push)   | monotonic SQL         | `packages/assistant/src/connections/ingestion/gmail-ingest.ts` |
| H    | latest history id; one below the add record of the earliest retryable failed fetch | `pollGmailHistory` (catch-up sweep) | monotonic SQL         | `packages/assistant/src/connections/ingestion/gmail-ingest.ts` |

Invariants: DB-enforced: one row per (credential, stream). Code-enforced: the cursor never moves back. It never moves past a message whose fetch failed with a retryable fault (SM-01). A 404 or a per-input status does not hold it. Assumed only: every message below the cursor was ingested. Mail with an old internal date is not in the realtime search, so a later push can still move past it. A message that fails with a non-HTTP fault on every run holds the catch-up cursor until Gmail history expires.

### Memory and user model

`user_facts.status` has the states proposed, confirmed, rejected, edited, superseded. There is no CHECK and no partial unique index for "one confirmed fact per single-valued key". That rule is code-only, through a per-key advisory lock.

| From                           | To                     | Trigger                             | Guard                                                             | Where                                                       |
| ------------------------------ | ---------------------- | ----------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------- |
| none                           | proposed, confirmed    | `proposeFact`                       | key lock; rejected-signature check; duplicate check               | `packages/assistant/src/knowledge/facts.ts`                 |
| none                           | confirmed              | `createFact`                        | key lock                                                          | `packages/assistant/src/knowledge/facts.ts`                 |
| proposed                       | confirmed              | `confirmFact`                       | key lock, re-read, CAS on proposed                                | `packages/assistant/src/knowledge/facts.ts`                 |
| confirmed                      | superseded             | single-valued conflict              | key lock                                                          | `packages/assistant/src/knowledge/facts.ts`                 |
| any                            | rejected               | `rejectFact`                        | none                                                              | `packages/assistant/src/knowledge/facts.ts`                 |
| any                            | edited (new confirmed) | `editFact`                          | key lock; the old row is updated by id with no status guard       | `packages/assistant/src/knowledge/facts.ts`                 |
| any                            | superseded             | `supersedeFact` (smoke script only) | none                                                              | `packages/assistant/src/knowledge/facts.ts`                 |
| confirmed standing instruction | rejected, edited       | `forgetStandingInstruction`, edit   | capture lock, per-fact lock, CAS on confirmed, observation append | `packages/assistant/src/knowledge/standing-instructions.ts` |

`style_profiles.status` (draft, active) has one writer, `upsertStyleProfile`, which selects then inserts or updates in a transaction. A bucket-level row has a null recipient and no unique protection (SM-41).

`projection_runs.status` (running, completed, failed) is well guarded. DB CHECKs pair status with the completion time and checksum, and (user, name, version) is unique. `startProjectionRun` reuses a running or failed run and refuses a completed one. The only production caller runs start, fold, and complete in one transaction, so a crash cannot leave a run stuck running.

The memory extraction stamp (row present means extracted; the graph capture time means folded) is written after the proposals, outside their transaction. A crash re-extracts, and `proposeFact` dedup absorbs it. The graph fold and its stamp share one transaction, but the stamp update has no "not yet captured" guard (SM-40).

## Web client

### Chat stream cell

`apps/web/src/lib/chat/chat-stream-state.ts` is an explicit reducer: `applyChatFrame`, `applyChatSeed`, `applyOptimisticStop`, and `applySyncedClose` are the transitions. The state is the current stream ref plus the retired run ids. The flags are not exclusive.

States: Empty, Seeded, Streaming, Compacting, AwaitingCapacity, AwaitingApproval, Completed, Stopped. A failed run is Completed here; its synced row shows the failure.

| From                  | To                    | Event                                                   | Guard                                               | Where                                        |
| --------------------- | --------------------- | ------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------- |
| any                   | Seeded                | send ack (`applyChatSeed`)                              | not the same (message, run); the old run is retired | `apps/web/src/lib/chat/chat-stream-state.ts` |
| Empty or another turn | Streaming             | first started, delta, reasoning, or tool frame          | frame id at or above the mount id; run not retired  | `apps/web/src/lib/chat/chat-stream-state.ts` |
| Seeded                | Streaming             | first frame of the same turn                            | mount id taken from the frame                       | `apps/web/src/lib/chat/chat-stream-state.ts` |
| Streaming             | Compacting and back   | compaction started, finished                            | same run; not stopped                               | `apps/web/src/lib/chat/chat-stream-state.ts` |
| Streaming             | AwaitingCapacity      | capacity retry                                          | same run; not stopped                               | `apps/web/src/lib/chat/chat-stream-state.ts` |
| Streaming             | AwaitingApproval      | approval requested                                      | same run; not stopped                               | `apps/web/src/lib/chat/chat-stream-state.ts` |
| AwaitingApproval      | Streaming             | any accepted delta, reasoning, or tool frame            | stop and sequence guards                            | `apps/web/src/lib/chat/chat-stream-state.ts` |
| live                  | Completed             | message completed                                       | same run; not stopped                               | `apps/web/src/lib/chat/chat-stream-state.ts` |
| not stopped           | Stopped               | Stop button (`applyOptimisticStop`)                     | not stopped; not awaiting approval (SM-16)          | `apps/web/src/lib/chat/chat-stream-state.ts` |
| live                  | Completed             | 45 s watchdog finds the synced row (`applySyncedClose`) | same message; not done; not awaiting approval       | `apps/web/src/lib/chat/use-chat-stream.ts`   |
| live                  | same (bus reconnects) | 45 s watchdog finds no synced row                       | not awaiting approval                               | `apps/web/src/lib/chat/use-chat-stream.ts`   |
| Stopped               | same (frames dropped) | any frame for the run                                   | stopped                                             | `apps/web/src/lib/chat/chat-stream-state.ts` |
| Stopped, Completed    | replaced              | a newer turn frame or seed                              | as above                                            | `apps/web/src/lib/chat/chat-stream-state.ts` |

Invariants (code): a replayed older turn cannot blank the live turn. A terminal tool card stays terminal. A late close after completed does not turn the completion into a failure. A stop drops later frames for that run only. Sub-agent frames never mount a turn. No client event fails a turn: a fatal bus close or a watchdog stall reconnects the bus in silence, and the `?since` replay resends the lost frames. The delta logs and tool cards drop a replayed frame.

The outer store in `apps/web/src/lib/chat/use-chat-stream.ts` keeps one stream per thread and releases an entry with no listeners once it is done. The watchdog is global, re-arms on any frame, and is armed only while a turn is not done and not awaiting approval. When it fires, it reads the synced row of each live turn through Replicache, closes a turn that has one, and reconnects the bus for the rest.

### Live artifact stream

`apps/web/src/lib/chat/use-artifact-stream.ts` keeps a map from tool call id to a live stream with a sequence, a done flag, an artifact id, and a mode.

| From    | To       | Event                                                      | Guard                                          | Where                                          |
| ------- | -------- | ---------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| none    | Writing  | first artifact delta                                       | none                                           | `apps/web/src/lib/chat/use-artifact-stream.ts` |
| Writing | Writing  | artifact delta                                             | sequence increases; not done                   | `apps/web/src/lib/chat/use-artifact-stream.ts` |
| Writing | Done     | tool frame succeeded or failed for that call               | none                                           | `apps/web/src/lib/chat/use-artifact-stream.ts` |
| Writing | dropped  | `completed` message frame of the run (`applyRunCompleted`) | the stream belongs to that run and is not done | `apps/web/src/lib/chat/use-artifact-stream.ts` |
| entry   | released | no listeners and every stream done                         | none                                           | `apps/web/src/lib/chat/use-artifact-stream.ts` |

Code-enforced: a stream that no tool frame resolved is dropped when its turn closes, so a Stop, a provider error, or a retry that left a call behind does not leave a partial body (SM-10). A resolved body stays until the synced row replaces it.

### Composer queue and dispatch

An implicit machine in `apps/web/src/lib/chat/use-queue-dispatch.ts` and `apps/web/src/lib/chat/use-chat-queue.ts`: Idle, Queued, Armed, Sending, Paused.

| From            | To                | Event                                               | Guard                                                             |
| --------------- | ----------------- | --------------------------------------------------- | ----------------------------------------------------------------- |
| Idle            | Sending           | submit with no turn on screen and an empty queue    | none                                                              |
| Idle, Streaming | Queued            | submit while a turn shows or the queue is not empty | queue cap                                                         |
| Queued          | Armed             | the stream stops showing                            | none                                                              |
| Armed           | Sending (head)    | effect                                              | not paused; nothing sending; not streaming; head not being edited |
| Sending         | Idle              | ok                                                  | entry removed                                                     |
| Sending         | Armed (retry)     | busy                                                | fewer than 5 attempts; 1 s sleep                                  |
| Sending         | Queued (disarmed) | hard error or busy budget spent                     | none                                                              |
| any             | Paused            | Stop with a non-empty queue                         | none                                                              |
| Paused          | Armed             | Resume                                              | none                                                              |

Invariants (code): one send per thread at a time. A thread switch resets the flags and fences a stale flush. The server busy check and the thread unique index are the real guard against two runs. No finding of its own.

### Send and pending turn

States in `apps/web/src/lib/chat/use-send-message.ts` and `apps/web/src/lib/chat/pending-turn.ts`: Uploading, PendingBubble, then Abandoned, Busy, or Acked; Acked goes to Seeded, then Mirrored (the Replicache message create), then Synced. Invariants (code): the Replicache mirror runs only after the ack, so a failed or busy start never pushes a row. The server re-checks attachment keys at turn time. A slow ack can lead to a duplicate send (SM-43).

### Approval card

Per card in `apps/web/src/components/approvals/use-approval-decision.ts`: Pending, Busy, then Error (back to Pending), Decided ("Resuming…"), or Restaged (re-seeded as Pending). The card goes away when Replicache drops the row; the server syncs only pending rows. Two tabs or two clicks get a 409 from the server status and row version checks. No finding of its own.

### Replicache client lifecycle

An explicit reducer in `apps/web/src/lib/replicache/context.tsx`. Stale lifecycles are fenced by object identity.

| From    | To                           | Event                                                      | Where                                     |
| ------- | ---------------------------- | ---------------------------------------------------------- | ----------------------------------------- |
| any     | Loading                      | user id or retry change                                    | `apps/web/src/lib/replicache/context.tsx` |
| Loading | Ready                        | client created                                             | `apps/web/src/lib/replicache/context.tsx` |
| Loading | load error                   | 3 import failures                                          | `apps/web/src/lib/replicache/context.tsx` |
| Ready   | pull error set or cleared    | puller fails or recovers                                   | `apps/web/src/lib/replicache/context.tsx` |
| Ready   | load error (session expired) | pull or push 401, or the poke event source reaching CLOSED | `apps/web/src/lib/replicache/client.ts`   |
| any     | initial                      | sign-out or cleanup                                        | `apps/web/src/lib/replicache/context.tsx` |

Invariants (code): a stale lifecycle cannot write state. The Replicache name is per user. A subscription never shows the previous client's data. The load error is sticky; the first message wins (SM-17).

### Replicache push handler

`packages/http/src/sync/push.ts`, per mutation: an unknown name advances the last mutation id and skips. An id at or below the last mutation id is skipped as a duplicate. Otherwise the mutator runs in a savepoint, and the last mutation id advances whatever the result.

Invariants:

- Code-enforced: a redelivered batch is inert. A foreign client group is refused.
- Assumed only: every mutator is idempotent on its own terms. Push takes no advisory lock, so two concurrent duplicate pushes can both pass the last mutation id check. Every mutator today tolerates this (conflict-free inserts, from-status CAS, row version guards). Nothing structural enforces it for a new mutator.
- By design: a transient DB error inside the savepoint drops the user action for good, and the optimistic patch reverts on the next pull with no signal.

Workflow edits send an expected row version that assumes the server bumps by exactly one (SM-44).

### SSE bus and replay cursor

The bus in `apps/web/src/lib/events/stream.ts` goes connecting, connected, then on a transient drop back to connecting (the browser retries with the last event id), or on a fatal CLOSED to reconnecting with backoff, and to disconnected when no subscriber remains. The replay state in `apps/web/src/lib/events/replay-state.ts` holds a cursor, active run barriers, and completed runs. Chat frames arm a barrier; a completed frame or a terminal run frame releases it. Code invariant: the server publishes completed on both the success and the failure closure, so barriers release. The replay state is not keyed per user (SM-45).

## Findings

Each finding has a stable ID. Do not renumber. When a fix lands, edit only the `Status:` line of that finding.

### SM-01 Gmail cursor advances past a message whose fetch failed

- Severity: high
- Confidence: confirmed
- Machine: Gmail history cursor
- Interleaving: a push arrives. `pollGmailRecent` in `packages/assistant/src/connections/ingestion/gmail-ingest.ts` lists messages from the last 5 minutes. Message A (history id H1) fails its fetch with a 429 or 5xx. Message B (H2, higher) succeeds. The function sets the high-water mark to the highest history id it fetched and writes the cursor even when the error count is above zero. The cursor is now H2. No new push arrives within 5 minutes, so A leaves the search window. The catch-up sweep `pollGmailHistory` reads the history list from the cursor, so it never sees A. A is never ingested or triaged.
- Other paths to the same loss:
  - More than 50 messages in 5 minutes. The realtime list is capped at 50 and fetches the newest only, but the cursor advances past all of them.
  - Mail with an old internal date (imports or inserts) is not in the "newer than 5 minutes" search, but a later push advances past it.
  - `pollGmailHistory` itself advances to the latest history id after per-message fetch errors.
- Evidence: the code comment says "A partial failure may move the cursor". ADR-0037 argues only the inverse race. The function doc says the catch-up sweep catches what the realtime path misses; the shared cursor makes this false. A full resync starts only on a push id jump above 1000. No test covers this.
- Impact: inbound mail is silently lost: no triage, no todo, no reply draft.

Status: fixed in #1698 (failed fetches and the list cap; the old internal date path is still open)

### SM-02 `notify` records a delivered email as failed, and retries cannot recover

- Severity: high
- Confidence: confirmed
- Machine: `email_sends.status` (and `briefings.status` through it)
- Interleaving:
  1. In `notify` in `packages/assistant/src/delivery/notify.ts`, the provider accepts the email. The update to sent is in the same try block. If that update throws (pool timeout, connection drop), the catch writes failed over a delivered email and returns failed. A crash between the provider call and the update leaves the row queued, and a stale-lease reclaim runs the send step again.
  2. A retry renders the body again. The email shell prints a "Generated on" minute, the briefing passes a new creation time, and alert copy is model-written per call. The body differs, so the provider answers 409 invalid_idempotent_request for the same key. The row is failed again. For 24 hours nothing can succeed; after that a retry sends a second copy.
  3. A concurrent caller can take a row another caller holds in queued (the upsert accepts any status but sent). Both call the provider. The loser gets a 409 and writes failed with an update by id only. If it commits after the winner, failed overwrites sent. The loser's briefing run then calls `markBriefingFailed`, also unguarded, over the winner's sent row.
- Evidence: the sent and failed updates match by id only. The idempotency comment in `notify` assumes a byte-identical retry. No test covers `notify`.
- Impact: for briefings, the user got the email but the row shows failed, the watermark of a sent row is never written, the next slot re-reports the same items, and a manual retry wipes the prose and composes again for nothing. Approval and workflow-blocked emails end permanently failed. For delivery alerts, a failed row does not silence the repeat window, so every 6-hour sweep recomposes the copy and gets a 409, and the next local day sends a duplicate alert.

Status: fixed in #1699

### SM-03 Skill Regenerate is refused for ever after one successful Learn

- Severity: high
- Confidence: confirmed
- Machine: `agent_runs.status` (dedup index)
- Interleaving: the learn workflow in `packages/assistant/src/skills/learn-skill.ts` declares a dedup key per skill. The documentation workflow in `packages/assistant/src/skills/skill-documentation.ts` does the same. Both comments say the intent is one concurrent run per skill. But `agent_runs_dedup_key_idx` is partial on status not failed and not cancelled, so a completed row keeps the key for ever. The user creates a skill, the learn run completes, and the user clicks Regenerate. `relearnSkill` calls `startRun`, the insert hits a unique violation on the dedup index, and the API answers 409 "A learn run is already in flight for this skill". Every later attempt does the same.
- Evidence: nothing clears the dedup key on completion. `createRun` handles only the occurrence conflict, so a different unique index raises 23505. For documentation, every later enqueue hits the same violation, and the persist step logs that a doc run is already in flight, but none is running.
- Impact: a skill can be relearned only if its last learn failed or was cancelled. Version 2 documentation never regenerates.

Status: fixed in #1700

### SM-04 A second manual "Run briefing" for the same date and slot does nothing

- Severity: medium
- Confidence: confirmed
- Machine: `briefings.status`, `agent_runs.status` (occurrence index)
- Interleaving: the cron morning run fails (model or provider outage). The user clicks Run, and manual run 1 fails. After the 60 s throttle the user clicks again. `enqueueBriefingRun` in `packages/assistant/src/briefings/run.ts` uses a fixed manual request id per date and slot, so the occurrence key is the same. The occurrence unique index is not partial. `createRun` does nothing on the conflict and returns the dead run id. `startRun` enqueues it again, and `leaseRun` returns none for a terminal run. The endpoint in `packages/http/src/me.ts` answers queued with that run id.
- Evidence: the endpoint comment says composed and failed rows fall through so that `beginBriefing` can resume or retry them. That retry can never start.
- Impact: the briefing stays failed for the rest of the day, and the UI says it was queued.

Status: fixed in #1699

### SM-05 Cancel sweeps reject approvals but leave the outcome as awaiting approval

- Severity: medium
- Confidence: confirmed
- Machine: `action_stagings.status` and `outcome`
- Interleaving: the user clicks "Cancel run" on a workflow approval card. `cancelRunInTx` in `packages/assistant/src/execution/service.ts` rejects the pending gated rows. It sets the status, reject reason, and decision time, but not the outcome, which stays awaiting_approval. `rejectLateCancelledRunStagings` does the same. Every other reject path (decide reject, expire, withdraw) sets the outcome to refused.
- Evidence: `apps/web/src/routes/-workflows-detail/history-format.ts` tests the awaiting outcome before the rejected status, and `packages/assistant/src/automation/run-history.ts` feeds the ledger rows straight into that tally. The cancel race test checks only the status and the reject reason.
- Impact: the history row of every cancelled run that had a pending card shows "1 waiting" for ever. Cascaded sub-agent cancels and late stagings have the same result.

Status: fixed in #1701

### SM-06 A cleared done todo escapes the re-suggest window

- Severity: low-medium
- Confidence: confirmed
- Machine: `todos.status`
- Interleaving: a triage todo carries a loop or object identity. The user completes it, then clears the done list (`todoClear`, done to cleared). The next notification for the same entity on a new thread reaches `suggestTodo` in `packages/assistant/src/tasks/suggest.ts`. The suppression query checks done and dismissed rows updated in the last 30 days. It ignores cleared. The resolved-match query filters the same way. No live or resolved match exists, so a new suggested todo is inserted.
- Evidence: cleared means "a done todo the user removed" in `packages/contracts/src/todos.ts`.
- Impact: completed work is suggested again only because the user tidied the list. Without the clear, the same notification is suppressed for 30 days.

Status: fixed in #1701

### SM-07 A later turn that rewrites an error artifact leaves it in error

- Severity: low-medium
- Confidence: confirmed
- Machine: `artifacts.status`
- Interleaving: turn 1 faults, so its artifact becomes error. In turn 2 the user says "finish it", and the agent replaces the body through `updateArtifact` in `packages/assistant/src/artifacts/write.ts` (the cross-run path supports this). `updateArtifact` writes the content and title only. `finalizeRunArtifacts` matches the closing run id, but the artifact keeps the creating run id, so turn 2 never finalizes it.
- Evidence: the sidebar shows "Generation incomplete" for the row, and sharing keeps only complete artifacts. The inverse also happens: a complete artifact that a later failing turn appends to stays complete. There is no DB CHECK.
- Impact: a repaired artifact looks broken and cannot be shared.

Status: fixed in #1701

### SM-08 A Stop pressed during a tool round outlives the approval park

- Severity: high
- Confidence: confirmed
- Machine: chat turn in-run state, `action_stagings.status`
- Interleaving:
  1. The dispatch tools step starts and reads the stop flag once (false).
  2. Free calls run, then a gated call stages a card.
  3. The user clicks Stop. The run is still running, so `stopChatTurn` sets the flag (15-minute TTL, never deleted).
  4. The round parks the run on the approval.
  5. Within 15 minutes the user approves. The staging becomes approved and dispatching, and the run wakes.
  6. The resumed dispatch tools step reads the flag, sees it set, and finalizes the turn as stopped.
- Evidence: the single flag check in `packages/assistant/src/chat/chat-turn.ts`; `packages/assistant/src/chat/stop-signal.ts` has no delete. `interruptChatRun` keeps the pending tool calls. `cancelRunInTx` touches only pending rows, so nothing sweeps approved rows of a finished run. No test covered this. Skipping the stop check on resume is not enough: `pollChatStopFlag` in the next chat turn step reads the same key, so the fix deletes the flag.
- Impact: the approved write, or the answer to an ask-user question, never runs. The staging stays approved and dispatching for ever. The user sees "approved" with no effect.

Status: fixed in #1708

### SM-09 A user-pinned triage thread stops minting todos and drafts for later messages

- Severity: medium
- Confidence: confirmed
- Machine: `email_triage` row
- Interleaving: the user retags thread T once (`triageTagOverride`). Later the counterparty sends a new message with a real ask. Classify runs and bills the model. `upsertTriage` in `packages/assistant/src/triage/store.ts` returns written false for a user-sourced row. The todo mint, the classified event, and the inbox update all run only when the row was written, so none of them happen. The document id never advances on a pinned row, so a manual reply draft on the new message returns no draft because "a newer document owns this thread's triage".
- Evidence: the comment in `packages/assistant/src/triage/workflow-operations.ts` explains written false only for the newer-message case. The triage tags RFC chooses a sticky category but does not say that todos and drafts stop. No test covered it.
- Decided intent: a user retag pins only the category. A later message still creates its todo and reply draft, and those follow the model's verdict for that message, not the pinned tag.
- Impact: new asks in any thread the user ever retagged vanish from the todo rail and from reply drafting, with no trace.

Status: fixed in #1711

### SM-10 A stopped document stream stays in "Writing…" for the session

- Severity: medium
- Confidence: confirmed
- Machine: live artifact stream (client)
- Interleaving: the model streams a document body. Artifact deltas are published from the tool input delta. The user clicks Stop (or the provider sends an error part). `packages/assistant/src/chat/stream-model-turn.ts` leaves the loop before the tool call part, so the tool never runs and no terminal tool frame is published. On the client, only a terminal tool frame or a fatal bus error marks the stream done; a completed message frame is ignored.
- Other paths to the same state: a Stop between the tool call part and the dispatch tools step, and a stream-timeout retry that leaves the first call's deltas behind.
- Evidence: `apps/web/src/lib/chat/use-artifact-stream.ts`; no stop case in the artifact stream tests. `selectByArtifactId` prefers any stream that is not done, so a later successful rewrite flips back to the stale partial body when it finishes.
- Impact: for a create, the auto-opened panel shows "Writing…" with a partial body for ever, though no artifact row will exist. For an update, whenever the user opens that artifact in the session, the sidebar shows the partial replacement text instead of the stored body. The thread entry is never released, so this lasts until a reload.

Status: fixed in #1710

### SM-11 A briefing row stuck in pending, gathering, or composing blocks retry for the day

- Severity: medium
- Confidence: confirmed (rare trigger)
- Machine: `briefings.status`
- Interleaving: several reads and writes in `packages/assistant/src/briefings/workflow-operations.ts` run outside the try blocks that call `markBriefingFailed`: the user read, the watermark read, and the activity window read in gather; the gather-output check, the activity window read, `markBriefingComposing`, and the state parse in compose. A throw there leaves the row non-terminal while the run ends failed. A run cancel (`cancelRunInTx`) or the lease backstop does the same, because the workflow had no terminal closure.
- Evidence: no sweeper resets a stale briefing row. The manual endpoint answers running for these states.
- Impact: the user cannot retry the briefing, and the cron for that slot does not fire again that day. The next day gets a new row.

Status: fixed in #1713

### SM-12 An approved `mcp.call` re-opens a connection the user disconnected

- Severity: medium
- Confidence: likely
- Machine: `mcp_connections.status`
- Interleaving: the model stages an MCP call (high risk, so it waits for approval). The user clicks Disconnect. Disconnect closes the generation, writes disconnected with a null pointer, and deletes the generation, so admission is open again. The user approves the staged call. The broker in `packages/assistant/src/tool-runtime/mcp/broker.ts` refuses only a missing row, then asks the manager to prepare the call. The manager opens a new generation (connecting), and catalog activation CASes the pointer from null and writes ready.
- Evidence: nothing on the broker path checks for disconnected. Railway verified pull in `packages/assistant/src/connections/verified-pull/railway.ts` has the same read-then-act gap, with a window of milliseconds.
- Impact: the connection is live again and shows Ready with no user reconnect. The call runs if the catalog hash is unchanged.

Status: open (not yet verified independently)

### SM-13 The MCP consent callback races a token refresh

- Severity: medium
- Confidence: likely
- Machine: `mcp_connections.status`, MCP OAuth tokens
- Interleaving: the connection hits insufficient scope and moves to auth_required; the live generation stays cached. While the user is on the consent screen, an agent call on that generation starts a refresh, which reads the old refresh token. The consent callback then saves the new tokens and scopes. It does not take the refresh lock. The refresh returns:
  - invalid grant (the server revoked the old grant on re-consent): the refresh nulls the brand-new tokens, so the next call is auth_required right after a successful consent;
  - success: the refresh saves the old-scope access token and resets the granted scopes, so the next call is insufficient scope again (a consent loop).
- Evidence: `packages/assistant/src/connections/mcp/oauth.ts` takes the refresh lock only in the refresh path; the callback in `packages/http/src/mcp.ts` does not. The OAuth tests have no callback-against-refresh case.
- Impact: a user who completes consent can be sent back to consent, possibly in a loop.

Status: open (not yet verified independently)

### SM-14 Deleting a chat thread does not stop its run

- Severity: medium
- Confidence: confirmed
- Machine: chat turn in-run state, `action_stagings.status`
- Interleaving: a chat turn parks on a send-email card. The user deletes the thread from the sidebar. The delete mutator in `packages/http/src/sync/write/chat.ts` deletes the thread row only. Runs have no FK to the thread; the thread id is in metadata. The approvals list joins only runs, so the card stays. The user approves, the run wakes, and the email is sent. Then `upsertCompletedRow` hits an FK violation on the message thread, the failure write fails the same way and is swallowed, and the run ends failed.
- Evidence: a mid-stream turn on a deleted thread also keeps calling the model and running autonomous tools until the finalize fails. Thread autonomy reads an absent thread as off, so autonomy is safe.
- Impact: a write runs for a thread the user deleted, and the run fails afterwards.

Status: fixed in #1709

### SM-15 A close-loop retraction from a stale read dismisses a newer ask

- Severity: medium
- Confidence: likely
- Machine: `todos.status`
- Interleaving: the user replies. Run R1 (reason reply) classifies and records that the user already replied. The counterparty then sends D1 with a new ask. Run R2 classifies it, and `suggestTodo` merges D1 into the live suggestion T or creates T'. R1 reaches the close-loop step and calls `resolveTodosForGmailSource` for the thread with suggested status, which dismisses T or T'.
- Evidence: runs are deduped per (event, reason), not serialized per thread. The dismissal has no time bound and takes no thread lock. The code comment in `packages/assistant/src/triage/workflow-operations.ts` notes that a second read could see a newer inbound, but the stored value is reused anyway.
- Impact: a fresh ask is silently dismissed. It reappears only on the next message.

Status: open (not yet verified independently)

### SM-16 The Stop button shows while the run waits on an approval

- Severity: medium
- Confidence: confirmed
- Machine: chat stream cell (client)
- Interleaving: the run waits for approval, and the composer still counts it as streaming. The toolbar in `apps/web/src/routes/-chat/composer/composer-toolbar.tsx` shows Stop. The user clicks it. `applyOptimisticStop` has no approval guard and marks the ref stopped and done. The server refuses the stop ("resolve the approval instead") and the client shows "Couldn't stop the reply". The approval dock is still visible. When the user approves, the run resumes, but every frame for it is dropped. If the queue was not empty, the stop also paused it.
- Evidence: `apps/web/src/routes/-chat/chat-shell.tsx` already forbids steering and send-now while an approval is pending; only the Stop button was missed.
- Impact: an error toast, and no live output after approval until the synced message lands.

Status: fixed in #1708

### SM-17 A non-2xx poke stream reads as "session expired" for the rest of the tab

- Severity: medium
- Confidence: likely
- Machine: Replicache client lifecycle (client)
- Interleaving: during a deploy, the poke event source in `apps/web/src/lib/replicache/client.ts` gets a 502, or the server throws at open and returns 500. The event source moves to CLOSED. The handler treats CLOSED as a 401 and reports an auth error. The load error is sticky, and retry with a live client clears only the pull error. The poke source is never reopened.
- Evidence: per the EventSource spec, CLOSED follows any non-200 response, not only a 401. The shared event bus treats the same condition as retryable.
- Impact: every surface shows a false "session expired" until a reload. Data refreshes only on the pull interval or after the user's own writes.

Status: open (not yet verified independently)

### SM-18 A long silent server phase trips the 45 s stream watchdog

- Severity: medium
- Confidence: likely
- Machine: chat stream cell (client)
- Interleaving: a turn starts and the server publishes compaction started. Foreground compaction runs for up to 2 minutes and publishes nothing. After 45 s the watchdog in `apps/web/src/lib/chat/use-chat-stream.ts` fires. It exempts approval waits but not compaction. Before the fix, the watchdog marked the ref stopped, so compaction finished, every later delta, and completed were dropped.
- Evidence: the server knows the 45 s budget for the capacity backoff but has no keepalive for compaction. The SSE heartbeat is a comment line, so it never reaches the frame handler. An unrelated frame on the bus re-arms the watchdog, which hides the problem on a busy bus. A single tool call that runs longer than 45 s with no frames can do the same (speculative).
- Impact: "Connection stalled", then a frozen partial bubble until the synced message replaces it. The run-complete notice also fires (SM-32).

Status: fixed in #1747

### SM-19 A run that fails while holding a pending card leaves a card nobody can decide

- Severity: medium
- Confidence: likely (rare trigger)
- Machine: `action_stagings.status`
- Interleaving: the dispatch inserts a gated row (it commits at once). Then the attempt dies or is reclaimed up to the backstop limit before the interrupt commits, or the interrupt commit throws an error that is not a supersede. The run ends failed with the row still pending and gated.
- Evidence: only cancel sweeps pending cards. The card is synced with no run status filter in `packages/http/src/sync/read/action-stagings.ts`. Decide answers 409 "Run has already finished". Expire refuses as already terminal. The expiry reconciler skips the row because it filters on waiting runs. The notification worker still emails it.
- Impact: a live-looking card that can never be approved, rejected, or expired.

Status: open (not yet verified independently)

### SM-20 `skill_runs.status` drifts from the agent run status

- Severity: medium
- Confidence: likely
- Machine: `skill_runs.status`
- Interleaving:
  - Stuck running: the failure and cancel closures run after the commit and are best effort. `driveClosure` in `packages/assistant/src/execution/terminal-closure.ts` logs and swallows every error. A DB error in `finalizeSkillRun`, or a process exit between the commit and the closure, leaves the row running for a terminal run. A re-delivered job cannot repair it, and no reconciler scans `skill_runs`.
  - Completed against failed: the learn persist step writes completed before the run commits. If that commit then fails and the run ends failed, the closure's failed write is refused by the terminal CAS.
- Impact: the skill History card shows "in progress" for ever, or the two tables disagree.

Status: open (not yet verified independently)

### SM-21 A deferred run that resumes keeps a stale "Deferred" headline

- Severity: medium
- Confidence: confirmed
- Machine: run columns (outcome)
- Interleaving: a user-authored workflow run defers in the readiness check (provider unhealthy). Defer writes a deferred outcome with a retry time. The retry passes, the run continues, and it parks on an approval for hours. The lease, next, and interrupt writes do not touch the outcome.
- Evidence: history returns the stored outcome for any status, and `apps/web/src/routes/-workflows-detail/history-format.ts` prefers it over the live status.
- Impact: history shows "Deferred. Retries" with a time in the past until a terminal write replaces the outcome.

Status: open

### SM-22 A sub-agent lost wakeup costs up to 6 minutes

- Severity: low-medium
- Confidence: confirmed (documented)
- Machine: `agent_runs.status` (join wake)
- Interleaving: the parent join in `packages/assistant/src/execution/sub-agent-join.ts` reads the child as not done, and the step returns park. The child finishes before the parent's interrupt commits. The wake sees the parent running and returns not waiting. The parent then parks. Only the dead-man job or the reconciler wakes it, at the 6-minute ceiling.
- Evidence: acknowledged in `packages/assistant/src/execution/sub-agent-join-wake-queue.ts`.
- Impact: a chat turn that awaits a fast sub-agent can stall about 6 minutes.

Status: open

### SM-23 A staged reply draft is not withdrawn when a newer message arrives

- Severity: low
- Confidence: likely (feature flag off by default)
- Machine: reply drafting
- Interleaving: the gate and the document check run only before the first staging. After the interrupt, nothing withdraws the approval. Occurrence ids are per (thread, document), so a newer message on the thread stages a second pending draft.
- Impact: the user can approve a reply to an outdated message, or send a duplicate after replying in Gmail.

Status: open (not yet verified independently)

### SM-24 The approval notification stamp causes false "The approval changed" errors

- Severity: low
- Confidence: likely
- Machine: `action_stagings.status` (row version)
- Interleaving: the notification worker in `packages/assistant/src/execution/approval-notification-worker.ts` stamps the notified time and bumps the row version 5 minutes after staging. A user who clicks approve before the next poke round-trip sends the old row version. `decideStagedAction` refuses with a stale version, and the route answers 409 "The approval changed. Review the latest contract."
- Impact: the user must retry. A typed answer in a question card can be lost, depending on the client.

Status: open (not yet verified independently)

### SM-25 Memory "forget" on a standing instruction bypasses its lock and audit

- Severity: low
- Confidence: likely
- Machine: `user_facts.status`
- Interleaving: the memory page in `apps/web/src/routes/-memory/memory-page.tsx` offers forget on every confirmed fact, including standing instructions. The push in `packages/http/src/sync/write/facts.ts` calls the generic `rejectFact`, not `forgetStandingInstruction`. This skips the capture lock, the CAS on confirmed, and the observation append.
- Impact: the audit chain misses the forget, and a concurrent revision of that row can be overwritten to rejected.

Status: open (not yet verified independently)

### SM-26 A background MCP refresh clears the required scopes of an auth_required row

- Severity: low
- Confidence: likely
- Machine: `mcp_connections.status`
- Interleaving: every token save, including a refresh, calls the connection authorization update, which clears the required scopes and the last error but leaves the status. After an insufficient-scope event, the next refresh on the cached generation erases the "Required: X" detail.
- Impact: the card and the alert lose the reason the user must reconnect.

Status: open (not yet verified independently)

### SM-27 A background compaction that finds nothing to do leaves the thread "compacting"

- Severity: low
- Confidence: likely
- Machine: conversation compaction
- Interleaving: a foreground compaction completes. The post-turn scheduler enqueues a new request with a cutoff the summary already covers; it does not compare watermarks. The job in `packages/assistant/src/chat/compaction/conversation-compaction-worker.ts` returns nothing_to_compact and writes neither a completion nor a failure.
- Evidence: the request time and the completion time also come from different process clocks, so clock skew can misorder them (speculative).
- Impact: each turn that needs a foreground compaction waits 500 ms for nothing until the next request or summary.

Status: open (not yet verified independently)

### SM-28 An attachment representation claim without a job stays pending for ever

- Severity: low
- Confidence: likely
- Machine: `chat_attachment_representations.status`
- Interleaving: `claimChatAttachmentEnrichment` commits the claim before the enqueue. The process dies between the two. Every later enqueue sees the existing row, and the scheduler skips attachments that have a representation row. There is no reaper.
- Impact: the attachment is never enriched; summaries fall back to the degraded text.

Status: open (not yet verified independently)

### SM-29 A BullMQ retry after a commit error is a no-op, and recovery runs the step again

- Severity: low
- Confidence: confirmed
- Machine: `agent_runs.status` (lease)
- Interleaving: the commit transaction throws an error that is not a supersede (a deadlock from the known lock-order exception, a lost connection, an outbox insert error). The heartbeat stops, and BullMQ retries after about 2 s. The retry's `leaseRun` sees running with a fresh checkpoint and returns none. The run waits out the stale window (60 s, or 6 minutes for user-authored model steps), and the reclaim runs the step body again.
- Evidence: the executor comment says the BullMQ retry makes this "noisy but safe", which overstates the retry.
- Impact: added latency, a second model bill, and one count toward the 3-reclaim backstop.

Status: open

### SM-30 Two active document asks of one kind on a thread never resolve

- Severity: low
- Confidence: confirmed
- Machine: `document_asks.status`
- Interleaving: a recruiter asks for a resume, then sends a reminder in the same thread (a second source message, so a second ask). The user sends the resume once. The reducer skips a kind with more than one active ask (ambiguous_active_asks). No expiry or supersede transition exists.
- Impact: both asks stay active, and the reconciler rescans them on each ingest. No user-facing reader exists yet, so nothing visible breaks today.

Status: open

### SM-31 A dry run leaves a real-date composed briefing that the next real run sends

- Severity: low
- Confidence: confirmed (development and smoke runs only)
- Machine: `briefings.status`
- Interleaving: a dry run leaves the row composed with prose and a watermark. A later cron or manual run for the same date and slot takes the composed resume path and emails the smoke prose with its old window.
- Evidence: only `apps/server/src/scripts/smokes/smoke-daily-briefing.ts` sets the dry run flag.
- Impact: a smoke run on a real account can send stale content.

Status: open

### SM-32 The run-complete notice fires for a stop, a bus error, or a watchdog stall

- Severity: low
- Confidence: confirmed
- Machine: chat stream cell (client)
- Interleaving: `apps/web/src/lib/chat/use-run-complete.tsx` fires "Alfred finished replying" and the chime for any done stream, with no check for an error or a stop.
- Impact: after SM-18, an unfocused tab shows "Connection stalled" and "Alfred finished replying" together.

Status: open

### SM-33 The workflow last run copy is "last finisher wins"

- Severity: low
- Confidence: confirmed (by design)
- Machine: workflow last run copy
- Interleaving: a run parks on an approval for a day and is then expired or cancelled. `recordWorkflowLastRun` updates with no ordering check, so it overwrites `last_run_status` of a newer run that finished earlier.
- Impact: the workflow list shows the last run to finish, not the last run to start. Note only if the list is meant to show the latest start.

Status: open

### SM-34 A `suggestTodo` merge can add a new ask to a todo the user just dismissed

- Severity: low
- Confidence: speculative
- Machine: `todos.status`
- Interleaving: the suggest transaction selects T as suggested. The user's dismiss push commits. The suggest merge update has no live-status guard, so it writes the new sources into the dismissed row. The rail push does not take the suggest advisory lock.
- Impact: the new ask is never shown.

Status: open (not yet verified independently)

### SM-35 A classify retry mints a todo again after the user dismissed the first one

- Severity: low
- Confidence: speculative
- Machine: `todos.status`
- Interleaving: attempt 1 mints a todo, then fails at the checkpoint. The user dismisses the todo during the retry backoff. Attempt 2 re-derives the todo. The dismissed match is by thread only, not by identity, so `suggestTodo` inserts a fresh suggested todo.
- Impact: a dismissed suggestion comes back.

Status: open (not yet verified independently)

### SM-36 The applied label can briefly disagree with a user override

- Severity: low
- Confidence: speculative (self-healing)
- Machine: `email_triage` row
- Interleaving: label reconcile holds the thread lock, labels Gmail with category A, then calls `setAppliedLabelId`, which does not check the category or source. A user override to B (no lock) commits in between. The row reads category B with the label of A.
- Impact: the relabel follow-up job converges it. The mismatch stays only if that job dies.

Status: open (not yet verified independently)

### SM-37 A stale runtime readiness verdict can re-block a repaired workflow

- Severity: low
- Confidence: speculative
- Machine: `workflows.status` and `blocked`
- Interleaving: `packages/assistant/src/automation/runtime-readiness.ts` reads the readiness context before its locked transaction, and the locked section checks only the published revision. The user reconnects and re-activates between the read and the lock. The stale problems are written back. The runtime path never clears a block, and the tick skips blocked rows.
- Impact: the workflow stays blocked until the user activates it again.

Status: open (not yet verified independently)

### SM-38 An MCP connection can stay stale with no pointer and no error

- Severity: low
- Confidence: speculative
- Machine: `mcp_connections.status`
- Interleaving: the stale write nulls the pointer. A later start failure CASes against the pointer read at start. If that was not null, the CAS misses. The row stays stale with no last error, and recovery selects only connecting or failed rows with an error. This needs three catalog changes during one start.
- Impact: the connection is not recovered automatically.

Status: open (not yet verified independently)

### SM-39 A rejected fact can come back auto-confirmed

- Severity: low
- Confidence: speculative
- Machine: `user_facts.status`
- Interleaving: `rejectFact` takes no key lock. `proposeFact` runs its rejected check and its duplicate check as two separate statements. A reject that commits between them lets the extractor insert the rejected value again, auto-confirmed at high confidence.
- Impact: the user sees a toast for a fact they just rejected.

Status: open (not yet verified independently)

### SM-40 Two overlapping extraction runs can fold the same documents twice

- Severity: low
- Confidence: speculative
- Machine: memory extraction stamp
- Interleaving: the run reads the captured set at start. The stamp update has no "not yet captured" guard. Two overlapping automatic runs for one user both fold the same documents.
- Impact: correspondence weights are counted twice.

Status: open (not yet verified independently)

### SM-41 Two concurrent style profile upserts can insert two bucket rows

- Severity: low
- Confidence: speculative
- Machine: `style_profiles.status`
- Interleaving: `upsertStyleProfile` selects, then inserts. A bucket-level row has a null recipient, and nulls are distinct in the unique index, so two concurrent upserts can both insert. The code comment acknowledges this. There is one caller path.
- Impact: duplicate profile rows for one bucket.

Status: open (not yet verified independently)

### SM-42 A stop and a quick navigation can revive the stopped turn

- Severity: low
- Confidence: speculative
- Machine: chat stream cell (client)
- Interleaving: the user clicks Stop and leaves the thread within about 400 ms. The unsubscribe releases the settled entry, and the retired run ids go with it. Late deltas arrive before the worker reads the stop flag. A new cell mounts a fresh, non-stopped ref.
- Impact: visible only if the user comes back inside that window; the completed frame then ends it.

Status: open (not yet verified independently)

### SM-43 A turn-start ack slower than 30 s can lead to a duplicate message

- Severity: low
- Confidence: speculative
- Machine: send and pending turn (client)
- Interleaving: the 30 s timeout in `apps/web/src/lib/chat/use-send-message.ts` fires. The client shows a toast and drops the bubble, but the server may still commit the thread, the user message, and the run. If the user resends the kept draft, the client mints a new message id, so the server's same-id reuse cannot match. The server answers busy, and the message is queued and sent a second time.
- Impact: a duplicate user message and reply.

Status: open (not yet verified independently)

### SM-44 Workflow edits assume the server bumps the row version by one

- Severity: low
- Confidence: speculative (latent)
- Machine: Replicache push handler, `workflows.status`
- Interleaving: `apps/web/src/lib/replicache/use-workflows.ts` sends the local row version, which includes an optimistic bump of one. The server bumps by two when one mutation carries both a definition patch and a status, and also bumps on its own for a block. A second edit sent before the pull then fails with a row version conflict, and the push handler drops it silently.
- Impact: a lost edit. The detail page sends the status alone today, so this is latent.

Status: open (not yet verified independently)

### SM-45 The event replay state is not keyed per user

- Severity: low
- Confidence: speculative
- Machine: SSE bus and replay cursor (client)
- Interleaving: the replay state lives in one local storage key. User A signs out mid-run, so A's barrier never releases in that browser. User B's replay cursor stays pinned to A's barrier, and B replays history from that id on every reload until the outbox reaper trims it. The pending turn map is also not cleared on sign-out.
- Impact: slow reloads on a shared browser.

Status: open (not yet verified independently)

### SM-46 A share and revoke race returns a dead link

- Severity: low
- Confidence: speculative
- Machine: shared thread publish and revoke
- Interleaving: `shareThread` returns an existing row while a concurrent `revokeSharedThread` deletes it. The owner gets a URL that answers 404. This needs the owner to click Share and Revoke on the same snapshot at once.
- Impact: a dead link. No data leaks.

Status: open (not yet verified independently)

## Issues

| Issue | Fix   | Group                             | Findings                                                                                                                                                                                                                       |
| ----- | ----- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #1694 | #1698 | Gmail ingestion cursor            | SM-01                                                                                                                                                                                                                          |
| #1695 | #1699 | Email delivery and briefing retry | SM-02, SM-04                                                                                                                                                                                                                   |
| #1696 | #1700 | Run dedup blocks regenerate       | SM-03                                                                                                                                                                                                                          |
| #1697 | #1701 | Terminal-state consistency        | SM-05, SM-06, SM-07                                                                                                                                                                                                            |
| #1703 | #1708 | Stop against approval             | SM-08, SM-16                                                                                                                                                                                                                   |
| #1704 | #1709 | Thread delete leaves a live run   | SM-14                                                                                                                                                                                                                          |
| #1705 | #1710 | Stale artifact stream             | SM-10                                                                                                                                                                                                                          |
| #1706 | #1711 | Pinned triage side effects        | SM-09                                                                                                                                                                                                                          |
| #1712 | #1713 | Briefing row left live            | SM-11                                                                                                                                                                                                                          |
| none  | #1747 | Silent stream recovery            | SM-18                                                                                                                                                                                                                          |
| none  | none  | Not yet scheduled                 | SM-12, SM-13, SM-15, SM-17, SM-19, SM-20, SM-21, SM-22, SM-23, SM-24, SM-25, SM-26, SM-27, SM-28, SM-29, SM-30, SM-31, SM-32, SM-33, SM-34, SM-35, SM-36, SM-37, SM-38, SM-39, SM-40, SM-41, SM-42, SM-43, SM-44, SM-45, SM-46 |
