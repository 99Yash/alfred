---
id: literal-pin-needs-why
section: Tests
status: review
rung: ast
feasibility: low
---

# Give a literal pin a `// why: #NNN` or ADR link, or delete it.

Why: a pin with no policy only fails when both files change together. Example: `EMBED_COST_CAP_USD` in `packages/corpus/test/embed-policy.test.ts`.

## Bad

```ts
test("the shipped cap is the documented $0.50", () => {
  assert.equal(EMBED_COST_CAP_USD, 0.5);
});
```

## Good

```ts
test("the shipped cap is the documented $0.50", () => {
  // why: ADR-NNNN sets $0.50 as the product limit for one embed run.
  assert.equal(EMBED_COST_CAP_USD, 0.5);
});
```

If no policy names the value, delete the pin. The `maxTokensForPrice` tests already exercise the cap.

## Mechanism

An AST rule cannot tell a policy literal from a change detector.

## Hits
