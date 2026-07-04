# Alfred Apps Guidance

## Runtime Shape Checks

- Use the shared guards from `@alfred/contracts` for unknown JSON/protocol data: `isRecord`, `isPlainRecord`, `toRecord`, `getPath`, `getStringPath`, `toStringArray`, `safeJsonParse`, and `isNonEmptyString`.
- In `apps/web`, keep runtime imports web-safe. `@alfred/contracts` and `@alfred/sync` are allowed; server packages such as `@alfred/api`, `@alfred/db`, `@alfred/env`, `@alfred/auth`, and `@alfred/ai` are not allowed in the browser bundle.

## App Split

- `apps/web` is browser code. Parse localStorage, URL search, SSE, and preview JSON through contracts helpers or a Zod schema before reading fields.
- `apps/server` may import server packages, but built-in workflows and smoke scripts should still use the same contracts helpers for unknown workflow input/output. Do not use smoke scripts as a dumping ground for unsafe casts.
