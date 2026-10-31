---
id: env-var-only-for-deploy-knob
section: Constants and ownership
status: stays-review
rung: none
---

# Use an environment variable only for a deploy knob, a secret or an endpoint.

Why: an env var is not a way to avoid a name. See "Environment variables" in `docs/reference/architecture.md`.

## Bad

```ts
// packages/env/src/server.ts
TRIAGE_BATCH_SIZE: z.coerce.number().int().positive().default(25),
```

No deploy sets a different value. The variable only gives the number a name.

## Good

```ts
// the triage module, next to the loop that reads it
/** Threads per classifier call. A larger batch hits the output token cap. */
const TRIAGE_BATCH_SIZE = 25;
```

## Mechanism

Whether a value is a knob is a deploy fact, not a fact in the code.

## Hits
