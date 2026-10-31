---
id: name-timestamp-clock
section: Backend
status: review
rung: compiler
feasibility: low
---

# Name the clock of each timestamp. Compare only timestamps of one clock.

Why: creation, delivery, provider event and fire time are different clocks. Example: `scheduledFireTime`, #1358.

## Bad

```ts
async (job) => {
  return handleTick(new Date(job.timestamp));
};
```

BullMQ stamps the next scheduled job when the previous one runs, so `job.timestamp` is one interval early.

## Good

```ts
export function scheduledFireTime(job: Pick<Job, "timestamp" | "opts">): Date {
  return new Date(job.timestamp + (job.opts.delay ?? 0));
}

async (job) => handleTick(scheduledFireTime(job));
```

## Mechanism

Compiler: a brand for each clock. A wide migration for a rare bug.

## Hits

- #1358 packages/assistant/src/briefings/queue.ts: the briefing tick matched on `job.timestamp`, the creation clock, not the fire time.
