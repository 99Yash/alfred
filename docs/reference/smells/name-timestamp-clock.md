---
id: name-timestamp-clock
section: Backend
status: stays-review
rung: none
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

Compiler: a brand for each clock. It stays review. A brand needs a migration of every `Date` field that crosses a module, and the bug is rare. The two hits are in different fields: a queue job time and a provider merge time.

## Hits

- #1358 packages/assistant/src/briefings/queue.ts: the briefing tick matched on `job.timestamp`, the creation clock, not the fire time.
- #1672 briefings/provenance.ts compared the provider mergedAt with gap bounds that are delivery arrival times, with no comment
