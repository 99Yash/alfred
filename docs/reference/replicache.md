# Replicache

`packages/sync` ships the client-side mutators (currently `noteCreate`) and shared key helpers. Server-side push/pull/poke endpoints live at `/api/replicache/{push,pull,events}` (see `packages/http/src/sync/`). Pokes flow over Redis Pub/Sub on `replicache-pokes:u:<userId>` channels and reach the browser via SSE.

## Adding a new synced entity

1. Add an entry to `IDB_KEY` in `packages/sync/src/keys.ts` — one function that returns the prefix when called with `{}` and a single-row key when called with `{ id }`. The slug here drives every generic dispatcher downstream.
2. Define the read schema in `packages/sync/src/schemas.ts` and export its inferred type through `packages/sync/src/types.ts` (must include `rowVersion: number`).
3. Add `<entity><Action>Client` mutator + zod arg schema in `packages/sync/src/mutators/<entity>.ts`, register both in `mutators/index.ts` (`clientMutators` + `mutatorArgsSchemas`).
4. Add the matching server-side mutator as an `export async function` in `packages/http/src/sync/write/<domain>.ts` (create the file if the domain is new), and register it as one shorthand row in the `serverMutators` literal in `packages/http/src/sync/write/index.ts`. Write against the supplied `tx` (so it commits inside the push handler's outer transaction) and bump `row_version`. Pokes fire generically from the push handler after commit.
5. Add a fetcher as an `export const fetch<Domain>: EntityFetcher` in `packages/http/src/sync/read/<domain>.ts` (create the file if the domain is new), and register it as one row in the `ENTITY_FETCHERS` literal in `packages/http/src/sync/read/index.ts`, returning `{ id, rowVersion, serialized }` per row (`pull.ts` only consumes that row shape). Serializers stay in the domain file; throw `SerializationError` from `read/entity-row.ts` to skip a row instead of failing the pull. The CVR snapshot shape (`Partial<Record<IDBKeys, ClientViewMap>>`) is generic — no `cvr.ts` change needed.
