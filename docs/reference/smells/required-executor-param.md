---
id: required-executor-param
section: Backend
status: gated
rung: ast
rule: alfred/required-executor-param
---

# Do not make a transaction parameter optional. Make the caller choose between its transaction and a new one.

Why: with `tx?: DbTransaction`, a caller that forgets the argument still compiles. The write then runs on a second pooled connection, outside the caller's transaction and its locks. Example: the `exec` choice of the fact owners in `packages/assistant/src/knowledge/facts.ts`.

## Bad

```ts
export async function createDraft(args: {
  userId: string;
  definition: unknown;
  tx?: DbTransaction;
}) {
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

AST rule `alfred/required-executor-param`. It reports a parameter, a property signature or a class field whose type annotation names `DbTransaction`, as the whole type or as one member of a union, when one of these is true:

- the slot is optional (`tx?: DbTransaction`);
- the parameter has a default value (`runner: DbRoot | DbTransaction = db()`);
- the union also has `undefined` (`exec: DbTransaction | undefined`).

The name match reads the last segment of the type name, so `Db.DbTransaction` also matches. The rule does not report a callback type that takes a transaction (`body?: (tx: DbTransaction) => …`), a `tx?: never` slot, or a local variable.

An oxlint JS plugin has no type information. So the rule does not see these forms (false negatives):

- an alias of the transaction type: `DbRunner`, `AgentDbExecutor`, `PreferenceExecutor`, `DbExecutor` in `packages/integrations/src/google/credentials.ts`, and `WorkflowExecutor` in `packages/assistant/src/automation/revisions.ts`. 47 parameters use an alias with a `= db()` default, such as `runner: DbRunner = db()`, and 10 slots use `?:` with an alias. These stay for review.
- a type that a mapped or derived type builds: `Partial<{ tx: DbTransaction }>`, `Parameters<typeof f>[1]`;
- an options type that a file imports and then makes optional with `Partial`.

The rule has no false positive in the tree. A slot that names `DbTransaction` and lets the caller omit it is always the smell. A caller with no transaction passes `"own"` or `db()` explicitly.

The paydown made 28 slots required and added no disable comment:

- 22 slots now take `DbTransaction | "own"`. `"own"` keeps the old executor of a caller that passed nothing: the callee opens its own transaction, or it runs one statement on the root client. These slots are in `entity-graph.ts`, `affiliation.ts`, `projection.ts`, `entities.ts`, `observations.ts`, `gmail-kind-fold.ts`, `team-graph.ts` (`persistContacts`), `facts.ts` (`FactExec.exec`, and the `exec: DbTransaction | undefined` parameter of `inFactTransaction`) and the four workflow writers in `automation/revisions.ts`.
- 2 slots now take a plain `DbTransaction`, because each caller holds a transaction: `projectGmailWorksAtEdges` and `applyCorrespondenceIncrements`.
- 3 parameters are gone, because no caller passed a transaction: `previewContactKinds` (#1225), `recordOrgAffiliationOnConnect` and `failProjectionRun`.
- `upsertIntegrationCredential` lost its `= db()` default. The GitHub and bearer writers now pass `db()`.

`packages/http/test/workflows/revisions.test.ts` is in the type-check baseline, so the compiler does not see it. Its 23 calls now pass `tx: "own"` by hand.

## Hits

- #1526 packages/assistant/src/knowledge/facts.ts: an optional `exec` let a mutator escape the push savepoint and wait on its own advisory lock.
- #1225 packages/assistant/src/knowledge/team-graph.ts: `previewContactKinds` took a `tx?` that no caller passed.
- #1224 the grounded-works fold: a caller that omits `tx` splits the kind half and the edge half of one run into two transactions.
- #1114 the graph-grounding fold: omitting `tx` on the incremental path decoupled the increments from the `captured_into_graph_at` stamp.
