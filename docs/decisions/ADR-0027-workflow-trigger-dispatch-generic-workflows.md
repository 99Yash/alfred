# ADR-0027 — Workflow trigger dispatch: generic `workflows.tick` + denormalized `next_run_at` + unified `trigger` on `agent_runs`

## Amendment, 2026-08-01 — durable occurrence identity (#558)

BullMQ job IDs are no longer the source of truth for trigger idempotency. Each cron,
provider-event, and user-authored manual/test occurrence stores one database-unique
`agent_runs.occurrence_key`. The key remains unique after the run becomes terminal.

The cron dispatcher now advances `workflows.next_run_at` and creates the pending run
in one database transaction. It enqueues only after commit. A crash after commit and
before enqueue leaves a pending row that the existing recovery sweep can enqueue.
Provider redelivery and manual retries resolve the existing row through the same
unique claim. BullMQ job IDs remain a useful delivery optimization, but they do not
define occurrence identity.

The `createRun` trigger union requires the matching occurrence identity rather than
accepting an optional precomputed key. Manual callers provide a request id; the run
service adds the resolved workflow identity. Replay is a separate manual occurrence
linked through `replay_of_run_id` with an explicit original/latest revision choice.

This amendment replaces the original “Idempotency is a BullMQ jobId” decision and
the implementation note that accepted a missed fire between cursor advance and run
creation. The generic tick, denormalized cursor, and unified trigger decisions remain.

**Decision.** Three coordinated choices that together define how a `workflows` row becomes an `agent_runs` row:

1. **Cron dispatch is a single `workflows.tick` BullMQ repeatable** running every minute. There is no per-workflow BullMQ scheduler. The `workflows` table is the source of truth for "what should fire next."
2. **Scheduling state is denormalized onto `workflows`** as `next_run_at` and `last_scheduled_at` columns, with a partial index keying the tick query. `cron-parser` runs at write-time (when `trigger` mutates and after each fire), not in the per-tick hot path.
3. **`createRun` accepts a first-class `trigger` field**, mirrored on `agent_runs` as a `trigger jsonb` column. Cron, manual, event, and on-signal kinds all funnel through one `createRun` primitive — no per-kind execution paths.

**Why.**

- **One operational surface.** A second scan-and-fan-out tick (alongside `briefing.tick` per ADR-0025) keeps the operator's mental model coherent — every recurring fan-out in the codebase is "find a BullMQ tick log; read what it dispatched." Per-workflow schedulers would shard that view across N BullMQ entries.
- **Lifecycle is a row edit.** Activate/Pause/Edit/Delete on a workflow is a `workflows` UPDATE that also recomputes `next_run_at`. No reconciliation between two stores (the row and a BullMQ scheduler) is required. Per-workflow schedulers would require a hook on every mutation that adds/removes/replaces the BullMQ entry; mismatched state is a class of bug that doesn't exist here.
- **The tick is an index lookup, not a scan.** Denormalizing `next_run_at` + `(status='active' AND trigger->>'kind'='cron')` partial index means each tick is `WHERE next_run_at <= now() ORDER BY next_run_at LIMIT 100` — O(log n), no per-row cron parsing. `cron-parser` is a write-time dep, not a hot-path dep.
- **Idempotency is a BullMQ jobId, not a database read.** The tick enqueues with `jobId = workflow:{workflowId}:scheduled:{nextRunAtIso}`; BullMQ's native dedup makes a retried tick a no-op without consulting `agent_runs`. The next fire uses a different `nextRunAtIso`, so the jobId is unique per scheduled instant.
- **Unified `trigger` field future-proofs the event story.** Today m12 only emits `kind='cron'` and `kind='manual'` triggers. m13's event router (Gmail webhook, calendar push, etc.) builds the same `trigger` block (`{ kind: 'event', eventId, payload }`) and hands it to the same `createRun`. No second execution path to invent; no `metadata.triggeredBy` migration when event triggers land.
- **`trigger.kind` is a first-class filterable field.** "Show all event-triggered runs in the last 24h" or "filter History tab to cron-only" is a `trigger->>'kind' = '…'` JSONB filter — the `workflows` partial index already covers the cron-dispatch path; if `agent_runs` history queries ever need an index, add one on `trigger->>'kind'` (or promote to a generated column) at that point.
- **`trigger.scheduledFor` distinguishes wall clock from scheduled time.** A tick fired at `09:00:23` for the `09:00:00` schedule stamps `scheduledFor = "09:00:00"` and `started_at = "09:00:23"`. Useful when a deploy or Redis blip delays the tick.

**Schema sketch.**

```
workflows                                  -- new columns + index
  ADD COLUMN next_run_at        timestamptz
  ADD COLUMN last_scheduled_at  timestamptz
  CREATE INDEX workflows_next_run_at_idx
    ON workflows (next_run_at)
    WHERE status = 'active' AND trigger->>'kind' = 'cron'

agent_runs                                 -- new column
  ADD COLUMN trigger jsonb
    -- { kind: 'cron'    | 'event'    | 'manual'    | 'on_signal',
    --   scheduledFor?:  timestamptz iso (cron),
    --   eventId?:       text         (event idempotency key),
    --   payload?:       jsonb        (event payload),
    --   signalName?:    text         (on_signal) }
```

**Tick query.**

```sql
SELECT id, slug, user_id, brief, trigger, next_run_at
FROM workflows
WHERE status = 'active'
  AND trigger->>'kind' = 'cron'
  AND next_run_at <= now()
ORDER BY next_run_at ASC
LIMIT 100;
```

Per row: (1) `createRun({ workflowSlug, userId, trigger: { kind: 'cron', scheduledFor: nextRunAtIso } })`; (2) `enqueueRun(runId, { jobId: \`workflow:${id}:scheduled:${nextRunAtIso}\` })`; (3) compute `next_run_at`via`cron-parser`from the row's`trigger.schedule`+ tz, UPDATE the row with new`next_run_at`and`last_scheduled_at = scheduledFor`. The `LIMIT 100`is a personal-scale ceiling — if N grows past one tick's budget, cursor on`next_run_at` and re-tick. Today 100 covers a lifetime; document the cursor as future work.

**`createRun` signature.**

```ts
createRun({
  userId,
  workflowSlug,
  input,
  trigger: { kind, scheduledFor?, eventId?, payload?, signalName? },
  metadata?,                  // remains for diagnostic breadcrumbs
})
```

Existing call-sites that pass `metadata: { triggeredBy: '…' }` migrate to `trigger: { kind: '…', … }` — most of them are builtin dispatchers (briefing tick, triage poll, cold-start callback) and migrate cleanly.

**Implementation notes.**

- `next_run_at` is recomputed at exactly two moments: (i) after a `workflows` write that changes `trigger` or flips `status` to `active`; (ii) inside the tick handler, right after `createRun` succeeds for that row. Both happen inside the same transaction as the row update for write-(i) and the same tx as `createRun` for write-(ii).
- Tz resolution: workflow row's `trigger.timezone` (first), else `user_preferences.timezone` (fallback), else `UTC` (final fallback) — same chain as ADR-0025's morning briefing.
- m12 shipped only the dispatcher. The planned failed-run stub for user-authored workflows was scoped out before ship, so pre-m13 code threw on registry miss before inserting an `agent_runs` row. m13 replaces that behavior with the sentinel workflow fallback in ADR-0040.

**Alternatives.**

- (a) Per-workflow BullMQ scheduler with native cron pattern (rejected — adds lifecycle hooks on every mutation; shards the operational surface across N BullMQ entries; no read-view payoff at single-user scale; "BullMQ owns cron" optimization isn't load-bearing here).
- (b) Hybrid — builtins keep per-feature ticks; user-authored uses generic tick (rejected — creates two patterns; any new builtin would have to choose; doesn't simplify either side).
- (c) `pg_cron` (rejected — Postgres-extension dep, doesn't compose with BullMQ retry/observability story, no Railway-managed support for the extension).
- (d) Per-workflow Vercel/Inngest cron (rejected — vendor coupling for a primitive we already have via BullMQ; ADR-0006 already rejected vendor agent runtimes for the same reason).
- (e) Tick-time cron parsing without `next_run_at` denormalization (rejected — O(n) per tick + cron parsing in the hot path; "next 5 runs" UI requires the column anyway; the write-time cost is a single `cron-parser.next()` call).
- (f) Per-kind `createRun` variants (`createCronRun`, `createEventRun`, …) (rejected — three call paths means three places to keep in sync when adding fields; unified `trigger` matches the discriminated union we already validate at the `workflows.trigger` layer).
