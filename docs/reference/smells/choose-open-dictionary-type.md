---
id: choose-open-dictionary-type
section: Types
status: stays-review
rung: none
---

# Choose the type of an open dictionary.

Use a parsed schema, a `Record` keyed by a literal union with `satisfies`, a `Map`, or `JsonValue`.

Why: `Record<string, unknown>` is not a substitute for a parse. See `docs/research/narrow-record-types-2026-08-09.md`.

## Bad

```ts
const DISPATCH_OUTCOME_LEVEL: Record<string, "DEFAULT" | "WARNING" | "ERROR"> = {
  unknown_tool: "WARNING",
  rejected: "DEFAULT",
  failed: "ERROR",
};
```

The `string` key accepts a missing outcome and a misspelled outcome.

## Good

```ts
const DISPATCH_OUTCOME_LEVEL = {
  unknown_tool: "WARNING",
  rejected: "DEFAULT",
  failed: "ERROR",
} satisfies Record<DispatchRejectionOutcome, "DEFAULT" | "WARNING" | "ERROR">;
```

## Mechanism

`anti-slop/no-unsafe-dictionary-type` already rejects `Record<string, unknown>`. Which of the four forms fits is a design choice.

## Hits
