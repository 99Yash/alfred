# AI SDK

The installed version is whatever `pnpm-workspace.yaml`'s `ai:` catalog entry
pins. Read it there, and take version deltas from upstream's migration guide —
a restated changelog in this file goes stale silently and then teaches names
that do not compile.

What follows is only the part that is Alfred's own convention, which no other
source states.

Model selection: `route(name)` from `@alfred/ai`. Named routes include `boss`, `subAgent`, `cheap`, `webSearch`, `compactor`, `compactorFallback`, `standard`, and `deep`; call `.model()` on the returned handle. The route's reasoning and provider options are installed on that model, so do not pass them again. A stored model id comes from `result.finalStep.response.modelId`, which names the leg that served the final step; the route model's own `modelId` always names the primary. That read is correct only when the final step produced the stored output; when the stored output comes from a tool and the loop can continue after it, read `response.modelId` from the last step whose `toolResults` (not `toolCalls`, which also list a rejected call) include a call of that tool. This holds only when each successful return of the tool stores the output; if the tool can return without a store, match the stored call's `toolCallId`. Do not call AI SDK provider functions directly from route handlers, and do not hardcode string model IDs in type positions — `LanguageModel` is a union.

Metering is not optional. Go through the `metered*` wrappers in `@alfred/ai` (`meteredGenerateText`, `meteredGenerateObject`, `meteredStreamText`) rather than the bare SDK calls, so every request lands in the cost rollups.

Cancellation: give every generate or stream call an `abortSignal` (`alfred/ai-call-needs-abort-signal`). Pass the caller's run, request or job signal, combined with `AbortSignal.timeout(MS)` through `AbortSignal.any` when both exist. When no parent signal exists, pass `AbortSignal.timeout(MS)` with a named constant that is longer than a normal call. The wrappers' 600 s `timeout` is only a backstop. The SDK turns a `timeout` into an `AbortSignal.timeout`, so the two forms have the same deadline.

Live web search runs on grounded Gemini 2.5 Flash via `route("webSearch").model()` (turn on Google Search grounding per-call with `googleSearchGroundingTools()`); route it through `meteredGenerateText` with `attribution.kind = 'web_search'` so cost rollups bucket it apart from the LLM line.

Embeddings: `embed(text, opts?)` and `embedMany(texts, opts?)` from `@alfred/ai/embeddings` call Voyage (`voyage-3.5` by default) through metering. All embedding dimensions must be 1024.
