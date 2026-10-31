---
id: array-sort-in-place
section: Frontend
status: candidate
rung: ast
feasibility: medium
issue: #1629
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

Built-in oxlint rule: `unicorn/no-array-sort`. About 150 sites remain, so a paydown comes first; the rule has a fix suggestion.

## Hits

- #1572 apps/web/src/lib/replicache/use-briefings.ts: `useBriefings` and `useBriefing` sorted the subscription result in place.
- #1577 apps/web/src/lib/replicache/use-action-stagings.ts: the `select` called `values.sort(...)` and reordered the stored array.
