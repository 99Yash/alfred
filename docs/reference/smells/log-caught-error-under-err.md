---
id: log-caught-error-under-err
section: Backend
status: gated
rung: ast
rule: alfred/log-caught-error-under-err
---

# Log a caught error only under the `err` key of a `logger` call. Put only safe fields beside it, and mask PII.

`no-console` stops a `console` call outside `apps/web` and scripts.

Why: only the `err` key goes through the serializer that drops free text. An error under another key, or its message in a field, can carry a connection string or a token. Example: `serializeError` in `packages/logging/src/logger.ts`.

## Bad

```ts
} catch (error) {
  logger.warn({ error, detail: error.message }, "pull failed");
}
```

## Good

```ts
} catch (err) {
  logger.warn({ err, integrationId }, "pull failed");
}
```

## Mechanism

AST rule `alfred/log-caught-error-under-err` in `scripts/oxlint/alfred/rules/`. It follows a `catch` binding, or a `.catch(cb)` parameter, into a `logger` call. It reports the error or its text under a key other than `err`, and a derived value under `err`. `no-console` already stops the `console` path.

## Hits

- #1297 packages/assistant/src/chat/chat-turn-closure.ts: logged `turnError: toMessage(err)` beside `err`, so the raw fault message reached production logs.
- #1303 packages/assistant/src/triage/workflow-operations.ts: the log fallback wrote the raw `toMessage(err)` of a Drizzle fault outside the `err` key.
- #1307 packages/assistant/src/execution/approval-expiry-worker.ts: a per-row fault was logged as `toMessage(err)`, not under `err`.
- #1111 packages/assistant/src/context-search/documents-source.ts: passed `err: safeErrorDiagnostic(err)`, a string, so the serializer wrote `{"type":"string"}`.
