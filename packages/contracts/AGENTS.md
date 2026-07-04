# Alfred Contracts Guidance

`@alfred/contracts` is the shared, web-safe contract package. It is the right home for cross-boundary schemas, enums, limits, and tiny pure helpers.

## Dependencies

- Keep runtime dependencies web-safe and light. Do not import DB, env, auth, API, AI, mailer, or integration packages.
- Zod is allowed and already part of this package.

## Existing Runtime Helpers

- Unknown JSON/protocol objects: `isRecord`, `isPlainRecord`, `toRecord`, `getPath`, `getStringPath`, `toStringArray`, `isNonEmptyString`.
- JSON strings: `safeJsonParse`, `parseJsonWith`.
- JSON persistence/transcript values: `toJsonValue`, `sanitizeToolResult`, `boundToolResult`.
- Error text: `toMessage`, `apiErrorMessage`, `sanitizeErrorMessage`, `httpErrorFromResponse`.
- Tool identity and display: `isToolName`, `integrationFromToolName`, `humanizeToolName`, `hashToolInput`.

## Guard Semantics

- `isRecord` means plain object only: POJO or null-prototype object. It must reject arrays, `Date`, `Map`, class instances, SDK objects, timer handles, and driver errors.
- Add new guard/read helpers here instead of copying local `getPath`, `asRecord`, or `typeof value === "object"` plus casts around the repo.
- Do not change `hashToolInput` or canonical serialization to use `isRecord`; hashing intentionally works over own enumerable properties and `toJSON`, not just JSON POJOs.
