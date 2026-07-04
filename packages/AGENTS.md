# Alfred Packages Guidance

## Runtime Shape Checks

- For unknown JSON/protocol/provider payloads, prefer the shared `@alfred/contracts` guards: `isRecord`, `isPlainRecord`, `toRecord`, `getPath`, `getStringPath`, `toStringArray`, `safeJsonParse`, `parseJsonWith`, and `isNonEmptyString`.
- Treat `isRecord` as a plain-object proof: POJO or null-prototype object only. Date, Map, arrays, and class instances must not pass record guards.
- Do not add local copies of `getPath`, `asRecord`, or `typeof value === "object"` plus `as Record<string, unknown>` casts. If a helper is missing, add it once in `packages/contracts/src/guards.ts` and export it from `@alfred/contracts`.

## Boundary Ownership

- Model identity belongs in `@alfred/ai`: use `identifyLanguageModel(model)` instead of reading `.modelId` with a cast.
- Error strings belong in `@alfred/contracts`: use `toMessage`, `apiErrorMessage`, or `httpErrorFromResponse` instead of logging/casting full error objects.
- Keep `@alfred/contracts` runtime-light and web-safe. It must not import DB, env, auth, API, AI, or integration packages.
- Do not use `isRecord` for non-JSON class instances such as SDK models, timer handles, Drizzle/Postgres errors, or generic object serialization. Those need explicit structural checks because class instances are intentionally rejected by `isRecord`.
