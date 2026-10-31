---
id: name-policy-number
section: Constants and ownership
status: stays-review
rung: none
---

# Name a threshold, cap, TTL, retry count, batch size or budget.

Give it a short reason when the value is not clear. Simple arithmetic stays inline.

Why: an unnamed number hides a policy. Example: `CONTEXT_SEARCH_MAX_LIMIT` in `packages/contracts/src/context-search.ts`.

## Bad

```ts
limit: z.number().int().min(1).max(50).default(10),
```

## Good

```ts
/** Max evidence per search. A caller that wants more asks again. */
export const CONTEXT_SEARCH_MAX_LIMIT = 50;

limit: z.number().int().min(1).max(CONTEXT_SEARCH_MAX_LIMIT).default(CONTEXT_SEARCH_DEFAULT_LIMIT),
```

## Mechanism

`42` and `EMPTY_COMPLETION_MAX_RETRIES = 42` depend on context. A literal ban fires on simple arithmetic.

## Hits
