---
id: mock-test-asserts-wire
section: Tests
status: review
rung: ast
feasibility: medium
---

# Assert the wire or the state in a mock test, not only `calls.length`.

Why: a call count alone tests the mock.

## Bad

```ts
const result = await send({ userId, kind: "health_alert", idempotencyKey, subject, html, text });

assert.equal(calls.length, 1);
```

## Good

```ts
assert.equal(result.status, "sent");
assert.equal(calls.length, 1);
assert.equal(calls[0]?.options?.idempotencyKey, idempotencyKey);
assert.equal(calls[0].payload.headers?.["X-Alfred-Idempotency-Key"], idempotencyKey);
```

The Good block is from `packages/assistant/test/notify.test.ts`.

## Mechanism

AST: a `test` block whose only assertions are of that kind.

## Hits
