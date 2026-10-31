---
id: no-swallowed-try-catch
section: Backend
status: review
rung: ast
feasibility: low
---

# Do not let a `catch` clause with statements drop the error.

Rethrow it, log it, or return a failure value. `no-empty` fails only an empty `catch` body, and `alfred/no-swallowed-catch` reads only a `.catch(…)` handler, so check a `catch` clause that has statements.

Why: a silent `catch` hides the fault from the user and from the logs.

## Bad

```ts
try {
  await refreshCatalog(connectionId);
} catch {
  status = "idle";
}
```

## Good

```ts
try {
  await refreshCatalog(connectionId);
} catch (err) {
  logger.warn({ err, connectionId }, "catalog refresh failed");
  return { ok: false, reason: "refresh_failed" } as const;
}
```

## Mechanism

AST: a `catch` clause with statements that does not rethrow, log or return a failure value. The tree has about 500 `catch` clauses, and many of them map a fault to a value that the caller tells apart, such as `return null` for "a fault proves nothing" in `connections/verified-pull/`. An AST rule cannot tell that value from a value that hides the fault, so a first rule needs a narrow shape and a paydown of its own.

## Hits

- #1458 packages/assistant/src/realtime/user-channel-subscriptions.ts: a `catch {}` dropped a listener throw with no log.
