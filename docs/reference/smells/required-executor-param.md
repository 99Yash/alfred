---
id: required-executor-param
section: Backend
status: candidate
rung: ast
feasibility: low
issue: #1629
---

# Do not make a transaction parameter optional. Make the caller choose between its transaction and a new one.

Why: with `tx?: DbTransaction`, a caller that forgets the argument still compiles. The write then runs on a second pooled connection, outside the caller's transaction and its locks. Example: the `exec` choice of the fact owners in `packages/assistant/src/knowledge/facts.ts`.

## Bad

```ts
export async function createDraft(args: { userId: string; definition: unknown; tx?: DbTransaction }) {
  const executor = args.tx ?? db();
  // ...
}
```

## Good

```ts
export async function createDraft(args: {
  userId: string;
  definition: unknown;
  exec: DbTransaction | "own";
}) {
  // "own" opens a transaction here; a DbTransaction joins the caller's.
}
```

## Mechanism

AST: an optional parameter or property whose type annotation is `DbTransaction`. About 35 sites remain, and some of them are correct, so the rule needs a per-site decision.

## Hits

- #1526 packages/assistant/src/knowledge/facts.ts: an optional `exec` let a mutator escape the push savepoint and wait on its own advisory lock.
- #1225 packages/assistant/src/knowledge/team-graph.ts: `previewContactKinds` took a `tx?` that no caller passed.
- #1224 the grounded-works fold: a caller that omits `tx` splits the kind half and the edge half of one run into two transactions.
- #1114 the graph-grounding fold: omitting `tx` on the incremental path decoupled the increments from the `captured_into_graph_at` stamp.
