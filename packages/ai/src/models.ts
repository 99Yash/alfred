import { getStringField, isIndexable } from "@alfred/contracts";
import type { LanguageModel } from "ai";
import { z } from "zod";

/** Closed set: a new provider needs a factory and `model_prices` rows. */
export const PROVIDER_IDS = ["anthropic", "google", "openai"] as const;

export const providerIdSchema = z.enum(PROVIDER_IDS);

export type ProviderId = z.infer<typeof providerIdSchema>;

/** For a bare gateway string id, `provider` is `"unknown"`. */
export interface ModelIdentifiers {
  provider: string;
  modelId: string;
}

/** `google.generative-ai` becomes `google`, the form models.dev and `model_prices` use. */
export function normalizeProvider(raw: string): string {
  return raw.split(".")[0] ?? raw;
}

/** A model object, not a bare gateway id string. Only an object can key a WeakMap. */
export type ModelObject = Exclude<LanguageModel, string>;

/** `isIndexable`, not `isRecord`: `isRecord` rejects class instances. */
export function isModelObject(model: LanguageModel): model is ModelObject {
  return isIndexable(model);
}

/** Read `provider` and `modelId` off the model, with the provider normalized. */
export function identifyLanguageModel(model: LanguageModel): ModelIdentifiers {
  const provider = getStringField(model, "provider");
  const modelId = getStringField(model, "modelId");

  if (provider !== undefined && modelId !== undefined) {
    return { provider: normalizeProvider(provider), modelId };
  }

  return { provider: "unknown", modelId: String(model) };
}
