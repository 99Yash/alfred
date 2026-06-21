import type { LanguageModel } from "ai";
import { z } from "zod";

/**
 * Canonical model-id list — the single source of truth. The `ModelId` type and
 * the runtime `modelIdSchema` both derive from this one tuple (the same
 * `as const` + `z.enum` idiom as `TRIAGE_CATEGORIES` in `@alfred/contracts`),
 * so the literal union, the validator, and the registry keys can never drift.
 */
export const MODEL_IDS = [
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
] as const;

export const modelIdSchema = z.enum(MODEL_IDS);
export type ModelId = z.infer<typeof modelIdSchema>;

/**
 * Providers Alfred dispatches to. A closed, hand-enumerated set: adding one is
 * a real code change (new provider factory + `model_prices` rows), not data.
 * `openai` is a member because the transcription path meters through it
 * ({@link ../transcription}); it has no `MODEL_REGISTRY` entry because the
 * registry tracks *language* models only.
 */
export const PROVIDER_IDS = ["anthropic", "google", "openai"] as const;
export const providerIdSchema = z.enum(PROVIDER_IDS);
export type ProviderId = z.infer<typeof providerIdSchema>;

export interface ModelDescriptor {
  provider: ProviderId;
}

/**
 * Model id → provider, keyed by id. This is the *only* per-model metadata that
 * must live in code: it's the compile-time constraint behind {@link ModelIdFor}
 * (and the typed `anthropic(...)`/`google(...)` factories in `provider.ts`) plus
 * `reconcileServed` cost attribution. Everything else models.dev already carries
 * — context window, tool-call support, pricing, display name — and `db:sync-prices`
 * stores it in `model_prices`; read it from there (see `resolveModelContextWindow`
 * in `metering/prices.ts`) rather than re-hand-coding it here.
 *
 * `as const satisfies Record<ModelId, …>` does double duty: `satisfies` forces an
 * entry for *every* `ModelId` (a missing or unknown key is a compile error),
 * while `as const` preserves the literal `provider` so {@link ModelIdFor} can
 * filter by it.
 */
export const MODEL_REGISTRY = {
  "claude-opus-4-8": "anthropic",
  "claude-sonnet-4-6": "anthropic",
  "claude-haiku-4-5-20251001": "anthropic",
  "gemini-2.5-pro": "google",
  "gemini-2.5-flash": "google",
  "gemini-2.5-flash-lite": "google",
} as const satisfies Record<ModelId, ProviderId>;

/**
 * Registry ids for a given provider. Constrains the provider factories in
 * `provider.ts` so a typo'd or unregistered id (e.g. `anthropic("claude-opus-4-8")`
 * while the registry still said `4-7`) is a compile error, not a silent
 * cost-attribution miss.
 */
export type ModelIdFor<P extends ProviderId> = {
  [K in ModelId]: (typeof MODEL_REGISTRY)[K] extends P ? K : never;
}[ModelId];

/** `true` when `id` is a known registry model id (narrows to `ModelId`). */
export function isModelId(id: string): id is ModelId {
  return modelIdSchema.safeParse(id).success;
}

/**
 * Look up a registry entry by served/reported id. Returns `undefined` for ids
 * the registry doesn't track (provider dated aliases like `gemini-2.5-pro-002`,
 * transcription models).
 */
export function findModelDescriptor(id: string): ModelDescriptor | undefined {
  return isModelId(id) ? { provider: MODEL_REGISTRY[id] } : undefined;
}

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
 * `LanguageModel` union is `string | LanguageModelV2 | LanguageModelV3`; both
 * object members expose `provider` + `modelId`, so a plain `typeof === "object"`
 * narrows without the old `"provider" in model` duck-typing. The single home
 * for this logic — `prices.ts` and the metering wrappers both call it instead
 * of re-implementing provider-head splitting.
 */
export function identifyLanguageModel(model: LanguageModel): ModelIdentifiers {
  if (typeof model === "object" && model !== null) {
    return { provider: normalizeProvider(model.provider), modelId: model.modelId };
  }
  return { provider: "unknown", modelId: String(model) };
}
