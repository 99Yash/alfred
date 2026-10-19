import type { LanguageModel } from "ai-retry";
import type { MockLanguageModelV4 } from "ai/test";

/**
 * The SDK's V4 mock as the `LanguageModel` the code under test takes.
 * The mock implements the same provider spec, so it is assignable to `ai-retry`'s `LanguageModel` type.
 */
export function asModel(model: MockLanguageModelV4): LanguageModel {
  return model;
}
