---
id: no-updated-at-queue-key
section: Backend
status: review
rung: ast
feasibility: medium
---

# Do not use `updatedAt` or another `$onUpdate` column as a queue or schedule key.

Store the queue position in its own column or table.

Why: a pass that writes nothing never moves the key, so the same rows win every turn. Example: `integration_object_pulls`, #1355.

## Bad

```ts
const rows = await db()
  .select()
  .from(integrationObjects)
  .where(and(...conditions))
  .orderBy(desc(integrationObjects.updatedAt))
  .limit(limit);
```

## Good

```ts
const rows = await db()
  .select(getTableColumns(integrationObjects))
  .from(integrationObjects)
  .leftJoin(integrationObjectPulls, eq(integrationObjectPulls.objectId, integrationObjects.id))
  .where(and(...conditions))
  .orderBy(sql`${integrationObjectPulls.pulledAt} asc nulls first`)
  .limit(limit);
```

The driver stamps `pulledAt` before each read, so a row that proves nothing still goes to the back.

## Mechanism

AST: an `updatedAt` column inside an ordering or a comparison in a query chain.

## Hits

- #1355 packages/assistant/src/connections/verified-pull/driver.ts: target selection ordered by `updatedAt`; unreadable rows kept every slot.
