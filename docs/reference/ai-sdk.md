# AI SDK

The installed version is whatever `pnpm-workspace.yaml`'s `ai:` catalog entry
pins. Read it there, and take version deltas from upstream's migration guide —
a restated changelog in this file goes stale silently and then teaches names
that do not compile.

What follows is only the part that is Alfred's own convention, which no other
source states.

Model selection: `getBossModel()`, `getSubAgentModel()`, `getCheapModel()`, `getWebSearchModel()`, `getChatModel()` from `@alfred/ai`. Do not call AI SDK provider functions directly from route handlers, and do not hardcode string model IDs in type positions — `LanguageModel` is a union.

Metering is not optional. Go through the `metered*` wrappers in `@alfred/ai` (`meteredGenerateText`, `meteredGenerateObject`, `meteredStreamText`) rather than the bare SDK calls, so every request lands in the cost rollups.

Live web search runs on grounded Gemini 2.5 Flash via `getWebSearchModel()` (turn on Google Search grounding per-call with `googleSearchGroundingTools()`); route it through `meteredGenerateText` with `attribution.kind = 'web_search'` so cost rollups bucket it apart from the LLM line.

Embeddings: `embed(text, opts?)` and `embedMany(texts, opts?)` from `@alfred/ai/embeddings` call Voyage (`voyage-3.5` by default) through metering. All embedding dimensions must be 1024.
