import { getStringField, isIndexable } from "@alfred/contracts";
import type { EmbeddingModel, LanguageModel } from "ai";
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

/** A language model or an embedding model. `LanguageModel` already holds the string ids. */
export type IdentifiableModel = LanguageModel | Exclude<EmbeddingModel, string>;

/**
 * Read `provider` and `modelId` off the model, with the provider normalized.
 * An embedding model has the same two fields, so metering reads it here too.
 */
export function identifyLanguageModel(model: IdentifiableModel): ModelIdentifiers {
  const provider = getStringField(model, "provider");
  const modelId = getStringField(model, "modelId");

  if (provider !== undefined && modelId !== undefined) {
    return { provider: normalizeProvider(provider), modelId };
  }

  // A gateway model id is the string itself; a model object without the fields has no id to read.
  return { provider: "unknown", modelId: isIndexable(model) ? "unknown" : model };
}
