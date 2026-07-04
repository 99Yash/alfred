# Alfred AI Guidance

## Model Identity And Metering

- Use `identifyLanguageModel(model)` for provider/model ids. Do not read `.provider` or `.modelId` with local casts.
- LLM calls that should be attributed must use the metered wrappers (`meteredGenerateText`, `meteredGenerateObject`, `meteredStreamText`) instead of raw SDK calls, except for explicitly isolated scripts/probes.

## Provider Options

- Provider options are JSON-shaped bags. Use `toRecord` from `@alfred/contracts` before merging provider-specific objects like `providerOptions.anthropic`.
- Do not use local `as Record<string, unknown>` casts for provider metadata; use `getPath`, `toRecord`, or a Zod schema.

## SDK Objects

- AI SDK model instances are class/SDK objects, not JSON records. A direct `typeof model === "object"` check can be correct in `models.ts`; do not replace it with `isRecord`.
