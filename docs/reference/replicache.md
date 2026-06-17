# Replicache

`packages/sync` ships the client-side mutators (currently `noteCreate`) and shared key helpers. Server-side push/pull/poke endpoints live at `/api/replicache/{push,pull,events}` (see `packages/api/src/modules/replicache/`). Pokes flow over Redis Pub/Sub on `replicache-pokes:u:<userId>` channels and reach the browser via SSE.

## Adding a new synced entity

1. Add an entry to `IDB_KEY` in `packages/sync/src/keys.ts` — one function that returns the prefix when called with `{}` and a single-row key when called with `{ id }`. The slug here drives every generic dispatcher downstream.
2. Define the read schema in `packages/sync/src/schemas.ts` and export its inferred type through `packages/sync/src/types.ts` (must include `rowVersion: number`).
3. Add `<entity><Action>Client` mutator + zod arg schema in `packages/sync/src/mutators/<entity>.ts`, register both in `mutators/index.ts` (`clientMutators` + `mutatorArgsSchemas`).
4. Add the matching server-side mutator in `packages/api/src/modules/replicache/server-mutators.ts` — write against the supplied `tx` (so it commits inside the push handler's outer transaction) and bump `row_version`. Pokes fire generically from the push handler after commit.
5. Add a fetcher to `ENTITY_FETCHERS` in `packages/api/src/modules/replicache/entities.ts` returning `{ id, rowVersion, serialized }` per row (`pull.ts` only consumes that row shape). The CVR snapshot shape (`Partial<Record<IDBKeys, ClientViewMap>>`) is generic — no `cvr.ts` change needed.
