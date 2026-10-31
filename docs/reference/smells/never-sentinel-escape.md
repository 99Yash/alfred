---
id: never-sentinel-escape
section: Types
status: gated
rung: ast
rule: alfred/no-never-sentinel-binding
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
// A value parsed at its boundary cannot reach the default, so throw.
default:
  return assertNever(decision, "write decision");

// An unparsed HTTP response can carry a newer server value, so return a real value.
default:
  return { statusText: "Unknown status", alert: null };
```

## Mechanism

AST rule `alfred/no-never-sentinel-binding`: a variable with a `never` annotation in a `switch` clause. The rule reports the binding itself, not only the forms that leak it. The hits also leaked it through `Boolean`, `JSON.stringify`, and an object property.

The binding adds no check. `typescript/switch-exhaustiveness-check` keeps its default options, so it reports a missing union member when a `default` exists.

The paydown changed 75 sites. A site that leaked the binding or threw now calls `assertNever`. A site that returned a real value keeps it. Three sites that leaked the binding return a real value, because unparsed data can reach their `default`. Two web display functions read an unparsed HTTP response (`triggerLabel` for run history and `mcpConnectionPresentation`). `toAuthorshipSource` reads `documents.source`, which is text with no CHECK. Replicache rows are parsed on read, and a row that fails the parse is dropped, so a web `default` on a synced row calls `assertNever`.

The rule does not see a `default` that returns the narrowed value with no binding, such as `return status`.

## Hits

- #1566 apps/web MCP server status: the `default` returned the raw status string where the function now returned an object.
- #1547 packages/assistant/src/connections/object-state/sentry-reducer.ts: the `default` returned `"pull_request"` as a `SentryLifecycleEventType`.
- #701 packages/assistant/src/connections/ingestion: the new `payloadSchemaFor` switch ended in `return _exhaustive`.
- #676 packages/assistant/src/execution: the review found `return exhaustive` beside the repo `_exhaustive` form.
- #1219 user model: a `return exhaustive` default changed the runtime value of two arms that the compiler called unreachable.
