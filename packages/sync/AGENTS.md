# Alfred Sync Guidance

`@alfred/sync` owns the browser-safe Replicache protocol surface: key construction, synced read-model schemas and inferred types, client mutator argument schemas, and client mutators. See the [Replicache reference](../../docs/reference/replicache.md).

## Boundaries

- Keep this package browser-safe. Do not import DB, env, auth, API, AI, integrations, or other Node-only runtime code.
- Replicache models belong here; general browser-safe cross-boundary schemas belong in `@alfred/contracts`.
- Server push/pull endpoints, CVR persistence, row serialization, and server mutator implementations belong in `@alfred/api`. Database row types remain in `@alfred/db`.

## Protocol Invariants

- Define each synced read model with a schema and derive its type. Preserve its stable key format and `rowVersion` contract.
- Register client mutators and their argument schemas together. The matching server mutator must validate the same contract and run inside the push transaction.
- Treat key prefixes, mutator names, and serialized shapes as persisted protocol. Coordinate changes across client and server and provide migration compatibility when existing browser data requires it.
