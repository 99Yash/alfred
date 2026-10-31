---
id: existence-assert-pairs-behavior
section: Tests
status: review
rung: ast
feasibility: medium
---

# Pair an existence-only assert with a behavior assert in the same test.

Why: `assert.ok(x)` proves only that the import did not throw.

## Bad

```ts
test("send exists", async () => {
  const { send } = await import("../src/notify");
  assert.ok(send);
});
```

## Good

```ts
test("send delivers one email with the idempotency key", async () => {
  const result = await send({ userId, kind: "health_alert", idempotencyKey, subject, html, text });
  assert.equal(result.status, "sent");
  assert.equal(calls[0]?.options?.idempotencyKey, idempotencyKey);
});
```

## Mechanism

AST: a `test` block whose only assertions are of that kind.

## Hits
