---
id: idempotent-retried-work
section: Backend
status: stays-review
rung: none
---

# Make work that BullMQ or a webhook retries idempotent.

Derive a stable key.

Why: a retry must not repeat a side effect. Example: #576.

## Bad

```ts
const duplicate = await hasNonTerminalEventRun({ userId, workflowSlug: row.slug, eventId });
if (duplicate) return;

const { runId } = await createRun({ userId, workflowSlug: row.slug, input, trigger });
await enqueueRun(runId);
```

The read and the insert are not atomic. A webhook and its retry can both miss the read and start two runs.

## Good

```ts
try {
  ({ runId } = await createRun({ userId, workflowSlug: row.slug, input, trigger }));
} catch (err) {
  // A partial unique index on the event identity rejects the second run.
  if (!isDuplicateRunIndex(uniqueViolationConstraint(err))) throw err;
  result.skippedDuplicate++;
  return;
}
await enqueueRun(runId);
```

## Mechanism

Each needs knowledge of intent that the code does not state.

A check cannot find which side effect a retry repeats, or which fields make a stable key.

## Hits

- #576 packages/api/src/modules/workflows/events.ts: two concurrent deliveries of one event both passed the read and created two runs; a partial unique index on the event identity now stops the second.
