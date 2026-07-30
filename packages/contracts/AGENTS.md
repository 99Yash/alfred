# Alfred Contracts Guidance

`@alfred/contracts` owns browser-safe cross-boundary schemas and their inferred types, shared wire enums, client-visible limits, and small pure boundary helpers. Replicache keys, mutator arguments, and synced read models belong in `@alfred/sync`, not here.

## Dependencies

- Keep runtime dependencies browser-safe, light, and server-agnostic. Do not import DB, env, auth, API, AI, mailer, integration, or other Node-only packages.
- Define a schema once and export its `z.infer` type; do not maintain a parallel interface.
- Keep implementation-only constants and schemas in their owning package. A value belongs here only when browser and server must agree on it.

## Runtime Semantics

- Record guards prove JSON-shaped plain objects, not arbitrary JavaScript objects. They must reject arrays, dates, maps, class/SDK instances, timer handles, and driver errors.
- Narrow an `unknown` with `isRecord` before indexing it, or `toRecord` to get a `Record` or `{}` back. `isIndexable` is the separate, wider question of whether a field can be read at all — a `Date` answers the two oppositely, so pick the one matching the claim.
- Read nested fields off `unknown` or parsed JSON with `getPath` / `getStringPath` rather than chained `?.` plus a cast. Coerce sequences with `toStringArray`, which checks the element type, and test presence with `isNonEmptyString`.
- Parse untrusted JSON with `parseJsonWith(raw, schema, fallback?)`, or `safeJsonParse(raw)` when there is no schema. Never `JSON.parse` into a cast.
- Add generally reusable JSON parsing, traversal, error-text, or serialization behavior here instead of copying local cast-based helpers across packages.
- Convert caught `unknown` errors with `toMessage`; do not use `String(err)`, read `.message` without narrowing, or introduce another local error-string helper.
- Raise a request failure with an `Errors.*` factory (`throw Errors.NotFoundError("…")`) and catch it with `isApiError(err, "NOT_FOUND")`. `Errors` is the only door to `ApiError`: do not call the constructor, do not add a subclass, and do not pass a status beside a code. `API_ERROR_STATUS` owns that pairing.
- Build HTTP failures with `httpErrorFromResponse` and test them with `isHttpError`. `HttpError` is a provider's failure to us; `ApiError` is our failure to a client. Do not convert one into the other by hand-copying a status. Bound and redact anything derived from a response body with `summarizeBody` / `redactSecrets` before it reaches a log, and `sanitizeErrorMessage` before it reaches a model. A raw upstream body riding an error is how credentials leak.
- `parseEmailAddress` is the single normalizer and the single source of self-mail matching. Do not hand-parse `Name <addr>` headers or lowercase addresses inline.
- Canonicalize identity values with `canonicalizeIdentityValue` before comparison, deduplication, or stable-ID minting; reducers and mint chokepoints must share that one normalization rule.
- Display identifier slugs with `humanizeSlug` and complete tool names with `humanizeToolName`; do not scatter underscore replacement and title-casing across server and web surfaces.
- Narrow dynamic or persisted tool-name strings with `isToolName` before indexing `ToolName` records or dispatching; do not assert them with `as ToolName`.
- Preserve the documented semantics of canonical serialization and hashing; those operations may intentionally support values beyond plain JSON records.
