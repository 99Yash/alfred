---
id: no-swallowed-catch
section: Backend
status: candidate
rung: ast
feasibility: low
issue: #1629
---

# Do not swallow a caught error.

Rethrow it, log it, or return a failure value. `no-empty` fails only an empty `catch` body, so check a `catch` that has statements.

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

AST: a `catch` with statements that does not rethrow, log or return a failure value. `no-empty` already fails an empty body.

## Hits

- #1458 packages/assistant/src/realtime/user-channel-subscriptions.ts: `.catch(() => {})` on UNSUBSCRIBE, and a `catch {}` dropped a listener throw with no log.
- #1122 packages/assistant/src/triage/workflow-operations.ts: `readUserContextLine(...).catch(() => null)` made a failed read look like no chunk.
