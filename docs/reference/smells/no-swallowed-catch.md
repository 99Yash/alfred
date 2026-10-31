---
id: no-swallowed-catch
section: Backend
status: gated
rung: ast
rule: alfred/no-swallowed-catch
---

# Do not give a `.catch(…)` handler a body that drops the error and returns a constant.

Log the fault and keep the value, or return a failure value that the caller tells apart. Keep a deliberate swallow only with a disable comment that gives the reason.

Why: a handler such as `.catch(() => null)` makes a failure look like a real empty result, and no log shows the fault.

## Bad

```ts
const prior = await readUserContextLine(userId).catch(() => null);
```

## Good

```ts
const prior = await readUserContextLine(userId)
  .then((line) => ({ line, readFailed: false }))
  .catch((err: unknown) => {
    logger.warn({ err, userId }, "[triage] user context read failed");

    return { line: null, readFailed: true };
  });
```

## Mechanism

AST rule `alfred/no-swallowed-catch`. It reports a call `<expr>.catch(handler)` or `<expr>?.catch(handler)` when the first argument is an arrow or a function expression, sync or async, and its body is one of these:

- an empty block, also a block with only a comment in it;
- a block whose only statement is `return;` or `return <constant>;`;
- a constant expression.

A constant is a literal (`null`, `false`, `0`, `""`), `undefined`, `void <constant>`, a template literal with no expression, `[]`, `{}`, or a `-` or `!` of a constant. A constant body cannot read the error, so the rule does not read the parameters. Test, eval and script files are out of scope (`inGateScope`).

False positives. The rule cannot tell an expected failure from a hidden fault. The 31 deliberate swallows in the tree keep a disable comment with the reason:

- an error body read on a non-OK response, such as `res.text().catch(() => "")` (11 sites). The thrown error keeps the status;
- a best-effort close after a first fault, or on a close path (9 sites, most in `connections/mcp/client.ts`);
- a blocked autoplay, `audio.play()` or `video.play()` (4 sites in `apps/web`);
- a shutdown step (3 sites);
- a promise whose failure another caller gets (2 sites: the token cache in `session-cache.ts` and the refresh flight in `mcp/oauth.ts`);
- a fault that is already logged, or a rejection that comes only after the client closes (2 sites in `apps/web`).

False negatives. The rule does not see:

- a handler passed by name, such as `.catch(noop)`;
- the second argument of `.then(ok, fail)`;
- a handler that returns a non-empty default, such as `new Map()` or `{ items: [] }`. `getThreadState(…).catch(() => ({ … }))` in `triage/workflow-operations.ts` is one;
- a handler that returns a constant after other statements;
- a `try`/`catch` statement. [no-swallowed-try-catch](./no-swallowed-try-catch.md) keeps that form under review.

The paydown logged 14 handlers and kept the value of each: three in `verified-pull/driver.ts`, two in `verified-pull/vercel.ts`, one in `mcp/manager.ts`, two UNSUBSCRIBE calls and one ROLLBACK in `realtime/`, two reads in `triage/workflow-operations.ts`, two checks in the system tools, and the observability init in `apps/web/src/main.tsx`. Server code logs with `logger.warn({ err, … }, "[area] …")` from `@alfred/logging`, as `alfred/log-caught-error-under-err` requires.

Web code has no `@alfred/logging`, and no web wrapper reports a fault to Sentry. Its form is `console.warn("[area] …", err)` or `console.warn("[area] …", toMessage(err))`, as in `use-send-message.ts` and `onboarding-route.tsx`.

## Hits

- #1458 packages/assistant/src/realtime/user-channel-subscriptions.ts: `.catch(() => {})` on UNSUBSCRIBE.
- #1122 packages/assistant/src/triage/workflow-operations.ts: `readUserContextLine(...).catch(() => null)` made a failed read look like no chunk.
