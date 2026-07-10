# Alfred Contracts Guidance

`@alfred/contracts` owns browser-safe cross-boundary schemas and their inferred types, shared wire enums, client-visible limits, and small pure boundary helpers. Replicache keys, mutator arguments, and synced read models belong in `@alfred/sync`, not here.

## Dependencies

- Keep runtime dependencies browser-safe, light, and server-agnostic. Do not import DB, env, auth, API, AI, mailer, integration, or other Node-only packages.
- Define a schema once and export its `z.infer` type; do not maintain a parallel interface.
- Keep implementation-only constants and schemas in their owning package. A value belongs here only when browser and server must agree on it.

## Runtime Semantics

- Record guards prove JSON-shaped plain objects, not arbitrary JavaScript objects. They must reject arrays, dates, maps, class/SDK instances, timer handles, and driver errors.
- Add generally reusable JSON parsing, traversal, error-text, or serialization behavior here instead of copying local cast-based helpers across packages.
- Preserve the documented semantics of canonical serialization and hashing; those operations may intentionally support values beyond plain JSON records.
