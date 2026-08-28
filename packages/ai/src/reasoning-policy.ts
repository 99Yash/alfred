import type { AnthropicLanguageModelOptions } from "@ai-sdk/anthropic";
import type { GoogleLanguageModelOptions } from "@ai-sdk/google";
import type { OpenAILanguageModelResponsesOptions } from "@ai-sdk/openai";
import type { SharedV4ProviderOptions } from "@ai-sdk/provider";
import { EFFORT_LEVELS, MODEL_CAPABILITIES, MODEL_REGISTRY, type ModelId } from "./models";
import type { EffortLevel } from "./models";

export type ModelReasoningPolicy = EffortLevel | "disabled";

type AnthropicChatProviderOptions = Pick<AnthropicLanguageModelOptions, "thinking" | "effort">;
type GoogleChatProviderOptions = Pick<GoogleLanguageModelOptions, "thinkingConfig">;
type OpenAIChatProviderOptions = Pick<OpenAILanguageModelResponsesOptions, "reasoningEffort">;

type AnthropicEffortLevel = NonNullable<AnthropicChatProviderOptions["effort"]>;
type GoogleThinkingLevel = NonNullable<
  NonNullable<GoogleChatProviderOptions["thinkingConfig"]>["thinkingLevel"]
>;

function clampEffort(desired: EffortLevel, allowed: readonly EffortLevel[]): EffortLevel {
  const target = EFFORT_LEVELS.indexOf(desired);
  return allowed.reduce((best, current) =>
    Math.abs(EFFORT_LEVELS.indexOf(current) - target) <
    Math.abs(EFFORT_LEVELS.indexOf(best) - target)
      ? current
      : best,
  );
}

function isAnthropicEffortLevel(value: EffortLevel): value is AnthropicEffortLevel {
  return value !== "none" && value !== "minimal";
}

function isGoogleThinkingLevel(value: EffortLevel): value is GoogleThinkingLevel {
  return value === "minimal" || value === "low" || value === "medium" || value === "high";
}

function anthropicReasoning(
  modelId: ModelId,
  effort: EffortLevel,
): SharedV4ProviderOptions["anthropic"] {
  const { effortValues } = MODEL_CAPABILITIES[modelId];
  // SAFETY: empty object is a valid SharedV4ProviderOptions["anthropic"] (JSONObject) when model has no effort values.
  if (effortValues.length === 0) return {} as SharedV4ProviderOptions["anthropic"];
  const clampedEffort = clampEffort(effort, effortValues);
  if (!isAnthropicEffortLevel(clampedEffort)) {
    throw new Error(`${modelId} declares Anthropic-incompatible effort value "${clampedEffort}"`);
  }
  const bag: AnthropicChatProviderOptions = {
    thinking: { type: "adaptive", display: "summarized" },
    effort: clampedEffort,
  };
  // SAFETY: AnthropicLanguageModelOptions bag is a JSONObject-compatible provider options bag.
  return bag as SharedV4ProviderOptions["anthropic"];
}

function anthropicDisabled(): SharedV4ProviderOptions["anthropic"] {
  const bag: AnthropicChatProviderOptions = { thinking: { type: "disabled" } };
  // SAFETY: thinking:{type:"disabled"} is the SDK's Anthropic disable shape and a valid JSONObject.
  return bag as SharedV4ProviderOptions["anthropic"];
}

function googleReasoning(modelId: ModelId, effort: EffortLevel): SharedV4ProviderOptions["google"] {
  const { effortValues } = MODEL_CAPABILITIES[modelId];
  if (effortValues.length > 0) {
    const thinkingLevel = clampEffort(effort, effortValues);
    if (!isGoogleThinkingLevel(thinkingLevel)) {
      throw new Error(`${modelId} declares Google-incompatible effort "${thinkingLevel}"`);
    }
    const bag: GoogleChatProviderOptions = {
      thinkingConfig: { includeThoughts: true, thinkingLevel },
    };
    // SAFETY: Google bag with thinkingLevel is the SDK's Google shape, JSONObject-compatible.
    return bag as SharedV4ProviderOptions["google"];
  }
  const bag: GoogleChatProviderOptions = {
    thinkingConfig: { includeThoughts: true, thinkingBudget: -1 },
  };
  // SAFETY: budget-based Google bag is the SDK shape for non-level models.
  return bag as SharedV4ProviderOptions["google"];
}

function googleDisabled(): SharedV4ProviderOptions["google"] {
  const bag: GoogleChatProviderOptions = { thinkingConfig: { thinkingBudget: 0 } };
  // SAFETY: thinkingBudget:0 is the SDK's Google disable shape.
  return bag as SharedV4ProviderOptions["google"];
}

function openaiReasoning(modelId: ModelId, effort: EffortLevel): SharedV4ProviderOptions["openai"] {
  const { effortValues } = MODEL_CAPABILITIES[modelId];
  const bag: OpenAIChatProviderOptions = { reasoningEffort: clampEffort(effort, effortValues) };
  // SAFETY: OpenAI Responses reasoningEffort bag is JSONObject-compatible.
  return bag as SharedV4ProviderOptions["openai"];
}

function openaiDisabled(): SharedV4ProviderOptions["openai"] {
  const bag: OpenAIChatProviderOptions = { reasoningEffort: "none" };
  // SAFETY: OpenAI disable bag is the SDK shape.
  return bag as SharedV4ProviderOptions["openai"];
}

/** Resolve one model's provider-namespaced reasoning bag. */
export function reasoningOptionsForModel(
  modelId: ModelId,
  provider: "anthropic" | "google" | "openai",
  effort: EffortLevel,
): SharedV4ProviderOptions[string] {
  switch (provider) {
    case "anthropic":
      return anthropicReasoning(modelId, effort);
    case "google":
      return googleReasoning(modelId, effort);
    case "openai":
      return openaiReasoning(modelId, effort);
  }
}

export function disabledReasoningOptionsForModel(
  modelId: ModelId,
  provider: "anthropic" | "google" | "openai",
): SharedV4ProviderOptions[string] {
  switch (provider) {
    case "anthropic":
      return anthropicDisabled();
    case "google":
      return googleDisabled();
    case "openai":
      return openaiDisabled();
  }
  void modelId;
}

export function providerOptionsForModel(
  modelId: ModelId,
  reasoning: ModelReasoningPolicy,
): SharedV4ProviderOptions {
  // SAFETY: MODEL_REGISTRY maps every ModelId to its provider head; narrowing to the three heads is exhaustive.
  const provider = MODEL_REGISTRY[modelId] as "anthropic" | "google" | "openai";
  const bag =
    reasoning === "disabled"
      ? disabledReasoningOptionsForModel(modelId, provider)
      : reasoningOptionsForModel(modelId, provider, reasoning);
  // SAFETY: bag is SharedV4ProviderOptions[provider]; wrapping it under its provider key yields SharedV4ProviderOptions.
  return { [provider]: bag } as SharedV4ProviderOptions;
}
