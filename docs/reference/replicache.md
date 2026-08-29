# Replicache

`packages/sync` ships the client-side mutators (currently `noteCreate`) and shared key helpers. Server-side push/pull/poke endpoints live at `/api/replicache/{push,pull,events}` (see `packages/http/src/sync/`). Pokes flow over Redis Pub/Sub on `replicache-pokes:u:<userId>` channels and reach the browser via SSE.

## Adding a new synced entity

1. Add one entry to `SYNC_MODEL` in `packages/sync/src/sync-model.ts` — `model(prefix, schema, key)`, where `key` derives a synced entity's IDB id-part (the single source of truth for "which field is the id"; `prefix` + `key` drive every derived `IDB_KEY`, `IDBKeys`, and `SyncedEntity`).
2. Define the read schema in `packages/sync/src/schemas.ts` and export its inferred type through `packages/sync/src/types.ts` (must include `rowVersion: number`). Register the schema in the `SYNC_MODEL` entry as the entity's owning schema.
3. Add `<entity><Action>Client` mutator + zod arg schema in `packages/sync/src/mutators/<entity>.ts`, register both in `mutators/index.ts` (`clientMutators` + `mutatorArgsSchemas`).
4. Add the matching server-side mutator as an `export async function` in `packages/http/src/sync/write/<domain>.ts` (create the file if the domain is new), and register it as one shorthand row in the `serverMutators` literal in `packages/http/src/sync/write/index.ts`. Write against the supplied `tx` (so it commits inside the push handler's outer transaction) and bump `row_version`. Pokes fire generically from the push handler after commit.
5. Add a fetcher as `export const fetch<Domain> = syncEntity("<SLUG>", { query, map })` in `packages/http/src/sync/read/<domain>.ts` (create the file if the domain is new), and register it as one row in the `ENTITY_FETCHERS` literal in `packages/http/src/sync/read/index.ts`. `syncEntity` derives `{ id, rowVersion, serialized }` from the `SYNC_MODEL` entry (`pull.ts` only consumes that row shape). The mapper stays in the domain file; throw `SerializationError` from `read/entity-row.ts` to skip a row instead of failing the pull. The CVR snapshot shape (`Partial<Record<IDBKeys, ClientViewMap>>`) is generic — no `cvr.ts` change needed.
