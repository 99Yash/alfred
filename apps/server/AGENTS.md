# Alfred Server App Guidance

## Built-In Workflows And Smokes

- Built-in workflows receive `unknown` workflow input. Parse with the workflow's Zod schema, or use `getPath` / `getStringPath` for tiny smoke-only shapes.
- Smoke scripts are executable documentation. Keep them as strict as production code: no fake `{ text?: unknown }` casts for run output, no local record guards, and no broad JSON assumptions.
- Server code may import `@alfred/api`, `@alfred/db`, `@alfred/env`, and `@alfred/ai`, but still prefer contract helpers for wire/protocol data.

## Model And Error Helpers

- Use `identifyLanguageModel` from `@alfred/ai` for model ids.
- Use `toMessage` / `httpErrorFromResponse` for error text. Do not log whole error objects.
