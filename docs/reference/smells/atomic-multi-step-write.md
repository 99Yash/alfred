---
id: atomic-multi-step-write
section: Backend
status: stays-review
rung: none
---

# Wrap a multi-step write that must be atomic in one transaction.

Why: a partial write leaves a state that no reader expects. Example: `runAtomic` in `packages/db/src/helpers.ts`.

## Bad

```ts
const server = await ensureServerDefinition(input, db());

const [connection] = await db()
  .insert(mcpConnections)
  .values({ userId: input.userId, serverId: server.id, instanceKey: input.instanceKey })
  .returning();
```

A fault after the first write leaves a server definition with no connection.

## Good

```ts
return runAtomic(runner, async (tx) => {
  const server = await ensureServerDefinition(input, tx);

  const [connection] = await tx
    .insert(mcpConnections)
    .values({ userId: input.userId, serverId: server.id, instanceKey: input.instanceKey })
    .returning();
});
```

## Mechanism

Each needs knowledge of intent that the code does not state.

Two writes in one function can be independent on purpose. Only the author knows if a reader expects them together.

## Hits
