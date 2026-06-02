# AI SDK

Alfred uses AI SDK v6 (`ai@^6`). Common v6 differences:

- `maxTokens` → `maxOutputTokens` in `generateText`/`streamText`.
- `maxSteps` → `stopWhen: [stepCountIs(n)]`.
- `tool()` uses `inputSchema`, not `parameters`.
- `LanguageModel` is a union — do not hardcode string model IDs in type positions.
- `generateObject` _@deprecated_ — Use `generateText` with an `output` setting instead.

Model selection: `getBossModel()`, `getSubAgentModel()`, `getCheapModel()`, `getWebSearchModel()`, `getResearchModel()` from `@alfred/ai/provider`. Do not call AI SDK provider functions directly from route handlers. The two web-search models (Perplexity Sonar Pro for live, Sonar Deep Research for cold-start) must be routed through `meteredGenerateText` with `attribution.kind = 'web_search'` so cost rollups bucket them apart from the LLM line.

Embeddings: `embed(text, opts?)` and `embedMany(texts, opts?)` from `@alfred/ai/embeddings` call Voyage (`voyage-3.5` by default) through metering. All embedding dimensions must be 1024.
