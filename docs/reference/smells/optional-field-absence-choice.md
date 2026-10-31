---
id: optional-field-absence-choice
section: Types
status: stays-review
rung: none
---

# Choose `k?: T` or `k?: T | undefined` for each optional field.

Keep `k?: T` when absence has a meaning, and omit the key with a conditional spread.

Why: a present `undefined` binds `NULL` where an absent key takes the column `DEFAULT`. See "`exactOptionalPropertyTypes`" in `docs/reference/typescript.md`.

## Bad

```ts
interface CreateTodoArgs { title: string; status?: TodoStatus | undefined }

await db.insert(todos).values({ userId, title: args.title, status: args.status });
```

When `args.status` is `undefined`, the insert binds `NULL` and does not take the `"open"` default.

## Good

```ts
interface CreateTodoArgs { title: string; status?: TodoStatus }

await db
  .insert(todos)
  .values({ userId, title: args.title, ...(args.status ? { status: args.status } : {}) });
```

## Mechanism

The choice depends on what each consumer does with absence.

## Hits
