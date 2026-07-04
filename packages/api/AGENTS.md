# Alfred API Guidance

## Shape Boundaries

- For request bodies and mutator/tool inputs, parse with the owning Zod schema. After `safeParse`, avoid re-casting schema output; use typed fields or `getStringPath` when checking optional union leaves.
- For provider/webhook/Replicache/Event payloads, use `@alfred/contracts` helpers (`isRecord`, `getPath`, `getStringPath`, `toRecord`) before reading unknown fields.
- Do not add local `getPath`, `asRecord`, or `isObject` utilities.

## Places Where `isRecord` Is Wrong

- Drizzle/Postgres errors are class instances and may be wrapped through `.cause`. Use explicit structural walking for these, not `isRecord`.
- Timer handles and Node runtime objects are not JSON. Check the specific method/property you need, such as `.unref`.

## Domain Helpers To Reuse

- Model ids: import `identifyLanguageModel` from `@alfred/ai`.
- Error messages: use `toMessage`, `apiErrorMessage`, `sanitizeErrorMessage`, or `httpErrorFromResponse` rather than logging full errors.
- Tool results/previews: use `boundToolResult`, `sanitizeToolResult`, and `toJsonValue`.
- User-model writes must go through the existing observation/fact write boundaries and schemas; do not insert raw rows directly.
