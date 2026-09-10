import { isIndexable } from "@alfred/contracts";
import type { LanguageModel } from "ai";
import { z } from "zod";

/**
 * Providers Alfred dispatches to. A closed, hand-enumerated set: adding one is
 * a real code change (new provider factory + `model_prices` rows), not data.
 * `openai` also owns transcription, but its GPT entries are language models
 * dispatched through the Responses API.
 */
export const PROVIDER_IDS = ["anthropic", "google", "openai"] as const;

export const providerIdSchema = z.enum(PROVIDER_IDS);

export type ProviderId = z.infer<typeof providerIdSchema>;

/**
 * Provider + model id resolved off an AI SDK `LanguageModel`. `provider` is
 * normalized to the models.dev head (see {@link normalizeProvider}); both fall
 * back to `"unknown"` / the stringified model when the SDK hands us a bare
 * gateway string id rather than a model object.
 */
export interface ModelIdentifiers {
  provider: string;
  modelId: string;
}

/**
 * AI SDK exposes namespaced provider ids (`google.generative-ai`,
 * `anthropic.messages`, `openai.responses`); models.dev (and our
 * `model_prices` rows) use the short head (`google`, `anthropic`, `openai`).
 * Take everything up to the first `.`, leaving unknown providers intact.
 */
export function normalizeProvider(raw: string): string {
  return raw.split(".")[0] ?? raw;
}

/**
 * Resolve `{ provider, modelId }` from an AI SDK `LanguageModel`. The SDK's
 * `LanguageModel` includes gateway strings and versioned model objects. Every
 * object member exposes `provider` + `modelId`, so we read the two fields off
 * the runtime object rather than treating the SDK handle as JSON. `isIndexable`
 * is the correct guard for a class/SDK instance — `isRecord` rejects it on
 * prototype — and the `Reflect.get` reads keep the instance opaque.
 * The single home for this logic — `prices.ts` and the metering wrappers both
 * call it instead of re-implementing provider-head splitting.
 */
export function identifyLanguageModel(model: LanguageModel): ModelIdentifiers {
  if (isIndexable(model)) {
    const provider = Reflect.get(model, "provider");
    const modelId = Reflect.get(model, "modelId");

    // eslint-disable-next-line anti-slop/no-runtime-typeof -- SDK object field check, not JSON boundary parsing; `isIndexable` already proved indexability
    if (typeof provider === "string" && typeof modelId === "string") {
      return { provider: normalizeProvider(provider), modelId };
    }
  }

  return { provider: "unknown", modelId: String(model) };
}
