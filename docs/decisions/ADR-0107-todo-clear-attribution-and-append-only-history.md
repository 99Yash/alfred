# ADR-0107 — Todo clear-attribution and append-only history at the DB layer

**Status.** Accepted; implements #1177 with two scoped deviations noted below.

## Decision

1. **Every todo status write carries its actor.** `todos.resolved_by`
   (`user | agent | system`, nullable; NULL only on a never-transitioned row)
   plus free-text `resolved_reason`. UI Replicache mutators write `user`;
   `system.resolve_todo` / `system.remember` dismissal writes `agent`; the
   automatic `close-loop-todos` retraction writes `system`. This is the answer
   to "who cleared this?" and un-parks ADR-0052's deferred `closed_by` in
   renamed, three-actor form (`reconciler` becomes `system`, and the chat
   agent acting for the user gets its own value instead of hiding inside
   either).
2. **History is a trigger-written, append-only table.** `todo_events`
   `(todo_id, from_status, to_status, actor, reason)` is written only by the
   `todos_transition_history` trigger — mint on INSERT (actor = `created_by`),
   one row per status change on UPDATE (actor = `resolved_by`, `system`
   fallback so a missed writer stays visible instead of failing the write).
   Non-status writes (name edits, source merges) log nothing. A second
   trigger rejects UPDATE and DELETE on `todo_events`.
3. **Identity is guarded, lifecycle stays mutable.** A `BEFORE UPDATE`
   trigger on `todos` rejects changes to `id / user_id / created_by /
agent_run_id` and rejects removal or replacement of identity-bearing
   `sources` refs. Gmail `thread` refs are transport and may come and go
   (the #355 cap evicts them oldest-first); every other ref must survive.
4. **Receipts are evidence-append-only, not update-free.** Triggers reject
   DELETE on `event_receipts` and reject UPDATEs touching any evidence or
   identity column — but allow `processing_status / processed_at /
updated_at`, the lifecycle the `ingress.deliver` job owns
   (`markProcessed`). A literal "UPDATE rejected" rule would break delivery;
   corrections are still new rows, never mutations.

## Why triggers, not GRANT/REVOKE

The app runs on a single database role that legitimately UPDATEs both tables
(receipt lifecycle, todo status), so revoking UPDATE/DELETE would break the
product. Triggers fire for every role including the owner; bypass needs
superuser `session_replication_role` or dropping the trigger, both outside
application reach. That boundary is documented in migration 0134.

## Alternatives

- (a) Literal #1177 invariant 1 (reject all receipt UPDATEs) — rejected:
  contradicts the processing lifecycle ADR-0090/0097 put on the receipt.
- (b) App-level history inserts — rejected: every writer must remember, and a
  missed writer silently loses history; the trigger makes logging structural.
- (c) Binary `agent / human` actor — rejected: the automatic retraction has
  no human in the loop and must stay distinguishable from both UI clears and
  chat-agent dismissals.

## Residual risk

Per repository rule, no feature tests: the compiler proves the actor enums,
boundary parsing holds the inputs, and `check:constraint-snapshot` holds the
CHECKs. The trigger bodies themselves were exercised once against a scratch
Postgres (receipt evidence-guard, lifecycle pass-through, mint/dismiss/clear
history rows, identity-guard accept/reject cases, history append-only) — that
proof is not in the tree and will not catch a future trigger regression.
