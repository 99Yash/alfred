---
id: array-sort-in-place
section: Frontend
status: gated
rung: ast
rule: unicorn/no-array-sort
---

# Sort a copy with `toSorted`. Do not call `sort` on an array that another owner holds.

Why: `sort` changes its input. A Replicache subscription result, a query cache entry, or a prop is shared state, so an in-place sort reorders it for every other reader. Example: the `select` callbacks in `apps/web/src/lib/replicache/`.

## Bad

```ts
function sortedTodos(todos: SyncedTodo[]): SyncedTodo[] {
  return todos.sort(sortTodos);
}
```

## Good

```ts
function sortedTodos(todos: SyncedTodo[]): SyncedTodo[] {
  return todos.toSorted(sortTodos);
}
```

## Mechanism

Built-in oxlint rule: `unicorn/no-array-sort`. Its fix suggestion rewrote 198 sites when the rule was adopted.

A `sort` call as a bare statement stays legal under the default options of the rule. At adoption, all 21 such statements sorted a local array that the same function built. The rule cannot see who owns the receiver, so it does not report a bare `props.items.sort(...)` statement.

## Hits

- #1572 apps/web/src/lib/replicache/use-briefings.ts: `useBriefings` and `useBriefing` sorted the subscription result in place.
- #1577 apps/web/src/lib/replicache/use-action-stagings.ts: the `select` called `values.sort(...)` and reordered the stored array.
