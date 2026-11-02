---
id: no-query-in-loop
section: Backend
status: stays-review
rung: none
---

# Do not query in a loop. Paginate every list endpoint.

Why: an N+1 read grows with the data. Example: #1126.

## Bad

```ts
const resolveKey = async (key: CandidateKey): Promise<void> => {
  const ref = await KEY_RESOLVERS[key.match](store, args.userId, key);
  if (!ref) return;
  const state = await store.getState(args.userId, ref);
  if (state) stateByKey.set(candidateIdentity(key), state);
};

await Promise.all(candidates.filter((key) => key.match === "exact").map((key) => resolveKey(key)));
```

Each key costs two queries, so a read that proposes hundreds of keys holds the pool.

## Good

```ts
for (const group of exactByGroup.values()) {
  const resolved = await store.resolveByKeys(args.userId, group.provider, group.keyKind, group.keys.map((key) => key.keyValue));
  for (const key of group.keys) {
    const ref = resolved.get(key.keyValue);
    if (ref) refByKey.set(candidateIdentity(key), ref);
  }
}

const statesByObjectId = await store.getStates(args.userId, [...refByKey.values()]);
```

## Mechanism

AST: a query on a `db()` or transaction handle awaited inside a loop body or an async `.map`. It stays review. That rule also flags the Good example above, which awaits one batch query for each key group in a `for` loop. The #1672 hit was a correlated SQL subquery, and only a query plan shows that shape.

## Hits

- #1126 packages/assistant/src/connections/object-state/reconcile.ts: two queries for each candidate key in `reconcileEvidence`; fixed with one `inArray` query for each key group.
- #1672 knowledge/activity.ts correlated an array subquery on observations.source, so Postgres ran it once per row, with no time floor and no limit
