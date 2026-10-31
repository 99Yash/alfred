---
id: constants-file-only-when-coupled
section: Constants and ownership
status: stays-review
rung: none
---

# Make a dedicated constants file only when its values couple.

Why: a file of unrelated values fails the deletion test. Example: `derivePoolMax()` in `packages/env/src/pool.ts`.

## Bad

```ts
// constants.ts
export const POOL_MIN = 2;
export const TRIAGE_BATCH_SIZE = 25;
export const BRIEFING_SEND_HOUR = 7;
```

The three values share a file and nothing else.

## Good

```ts
// pool.ts: each value feeds the pool size
export const POOL_MIN = 2;
const CONNECTIONS_PER_STEP = 2;
const NON_AGENT_HEADROOM = 4;

export function derivePoolMax(agentWorkerConcurrency: number): number {
  return Math.max(POOL_MIN, agentWorkerConcurrency * CONNECTIONS_PER_STEP + NON_AGENT_HEADROOM);
}
```

## Mechanism

`42` and `EMPTY_COMPLETION_MAX_RETRIES = 42` depend on context. A literal ban fires on simple arithmetic.

## Hits
