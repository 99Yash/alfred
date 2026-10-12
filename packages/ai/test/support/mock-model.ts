import type { LanguageModel } from "ai-retry";
import type { MockLanguageModelV4 } from "ai/test";

/**
 * The SDK's V4 mock as the `LanguageModel` the code under test takes.
 * The mock implements the same provider spec at runtime, but `ai-retry` names its own `LanguageModel` type.
 */
export function asModel(model: MockLanguageModelV4): LanguageModel {
  // SAFETY: the mock implements every method `generateText`, `streamText`, and `withFallback` call.
  // eslint-disable-next-line anti-slop/no-chained-type-assertions -- the V4 mock and `ai-retry`'s `LanguageModel` are the same spec under two declared types
  return model as unknown as LanguageModel;
}
