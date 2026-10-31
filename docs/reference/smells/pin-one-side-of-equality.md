---
id: pin-one-side-of-equality
section: Tests
status: review
rung: ast
feasibility: medium
---

# Pin one side of an equality assert to a literal, an external artifact, or a second source.

A cross-check of two code paths keeps a `// tautology-ok: cross-check` marker and one literal-anchored test.

Why: a test that calls the same function on both sides cannot fail. Example: `packages/ai/test/voice/voice-sanitize.test.ts`.

## Bad

```ts
const input = "the real thing — not the commit";
assert.equal(sanitizeVoice(input), sanitizeVoice(input.trim()));
```

## Good

```ts
assert.equal(
  sanitizeVoice("the real thing — not the commit"),
  "the real thing; not the commit",
);
```

A cross-check keeps the marker and a literal anchor, as in `packages/assistant/test/context-search/rank.test.ts`:

```ts
assert.deepEqual(result.ranking.map((e) => e.cardId), result.evidence.map((e) => e.id));
// tautology-ok: cross-check that the parallel array tracks evidence order, anchored at rank.test.ts:453-456
assert.deepEqual(result.evidence.map((e) => e.id), ["rank-test:pair:2", "rank-test:pair:1"]);
```

## Mechanism

AST: two calls of one callee inside one `assert.equal`. The regex row is a `hint`.

The regex row is `self-mirroring-oracle` in `scripts/test-tautology-rules.mjs`.

## Hits
