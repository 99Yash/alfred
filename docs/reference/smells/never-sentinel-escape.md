---
id: never-sentinel-escape
section: Types
status: candidate
rung: ast
feasibility: medium
issue: #1629
---

# Do not return or print the `never` binding of an exhaustive `default`. Throw with `assertNever`, or return a real value of the return type.

Why: `never` is assignable to every type, so `return _exhaustive` compiles for any return type. At runtime, a value from a newer peer or an old row reaches the `default`, and the function returns the raw input as if it were a valid result. Example: `assertNever` in `packages/contracts/src/errors.ts`.

## Bad

```ts
default: {
  const _exhaustive: never = connection.status;

  return _exhaustive;
}
```

## Good

```ts
default:
  return assertNever(connection.status, "MCP connection status");
```

## Mechanism

AST: in a `default` clause, a `const` binding with a `never` annotation that is then returned, passed to `String`, or discarded with `void`. About 50 sites remain, so a paydown comes first.

## Hits

- #1566 apps/web MCP server status: the `default` returned the raw status string where the function now returned an object.
- #1547 packages/assistant/src/connections/object-state/sentry-reducer.ts: the `default` returned `"pull_request"` as a `SentryLifecycleEventType`.
- #701 packages/assistant/src/connections/ingestion: the new `payloadSchemaFor` switch ended in `return _exhaustive`.
- #676 packages/assistant/src/execution: the review found `return exhaustive` beside the repo `_exhaustive` form.
- #1219 user model: a `return exhaustive` default changed the runtime value of two arms that the compiler called unreachable.
