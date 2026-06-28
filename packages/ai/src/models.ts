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

/** Providers that currently have language models in {@link MODEL_REGISTRY}. */
export type ModelProviderId = (typeof MODEL_REGISTRY)[ModelId];

/**
 * Registry ids for a given provider. Constrains the provider factories in
 * `provider.ts` so a typo'd or unregistered id (e.g. `anthropic("claude-opus-4-8")`
 * while the registry still said `4-7`) is a compile error, not a silent
 * cost-attribution miss.
 */
export type ModelIdFor<P extends ModelProviderId> = {
  [K in ModelId]: (typeof MODEL_REGISTRY)[K] extends P ? K : never;
}[ModelId];

/**
 * Effort labels providers may accept (`reasoning_options[].effort` in models.dev),
 * weakest→strongest. This is a known-provider union, not Anthropic's vocabulary:
 * OpenAI exposes `none`/`minimal`, Gemini 3 exposes `minimal`, and Anthropic
 * exposes `xhigh`/`max`. The per-model `effortValues` below is the exact accepted
 * subset for that model; `PROVIDER_DISPATCH.clamp` snaps a requested tier to the
 * nearest value a given model actually accepts.
 */
export const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/**
 * Per-model structural facts that the provider layer needs at request time and
 * that a tier→model remap must not be able to get wrong. This is the *per-model*
 * axis (ADR-0078); the *per-provider* mechanics (reasoning-block shape, tool-name
 * shim policy) live in `PROVIDER_DISPATCH` in `provider.ts`.
 *
 * These mirror models.dev's `reasoning_options` / `temperature` for our six
 * registered ids; the non-gating `verify-capabilities` audit asserts they still
 * match the synced `model_prices` snapshot. models.dev is the *audit oracle*, not
 * a runtime source of truth (it has gaps — e.g. `structured_output` is absent for
 * every Anthropic model), so the values are code-resident.
 */
export interface ModelCapabilities {
  /**
   * Effort values the model accepts, weakest→strongest. `[]` means the model has
   * **no** effort/adaptive reasoning param — the provider must send a light/empty
   * reasoning block (Haiku 4.5 per ADR-0077; Gemini 2.5 models are budget/toggle
   * based). The vocabulary is provider-specific; do not filter unknown values out
   * of the audit, add them to {@link EFFORT_LEVELS} first.
   */
  readonly effortValues: readonly EffortLevel[];
  /**
   * Model accepts a `temperature` param. `false` on Opus 4.7+/Fable (they 400 on
   * any temperature). Recorded for future-proofing; Alfred sends no temperature
   * today, so nothing reads this at runtime yet.
   */
  readonly temperature: boolean;
}

/**
 * The closed capability map for the six registered ids. `as const satisfies
 * Record<ModelId, …>` forces an entry for every model (a missing or unknown key
 * is a compile error) while preserving the literal `effortValues` tuples so the
 * provider dispatch can clamp against them.
 */
export const MODEL_CAPABILITIES = {
  "claude-opus-4-8": {
    effortValues: ["low", "medium", "high", "xhigh", "max"],
    temperature: false,
  },
  "claude-sonnet-4-6": { effortValues: ["low", "medium", "high", "max"], temperature: true },
  "claude-haiku-4-5-20251001": { effortValues: [], temperature: true }, // ADR-0077: empty block
  "gemini-2.5-pro": { effortValues: [], temperature: true }, // budget-based; effort N/A
  "gemini-2.5-flash": { effortValues: [], temperature: true },
  "gemini-2.5-flash-lite": { effortValues: [], temperature: true },
} as const satisfies Record<ModelId, ModelCapabilities>;

/** `true` when `id` is a known registry model id (narrows to `ModelId`). */
export function isModelId(id: string): id is ModelId {
  return modelIdSchema.safeParse(id).success;
}

/** `true` when a registry model belongs to `provider` (narrows the model id). */
export function isModelIdForProvider<P extends ModelProviderId>(
  id: ModelId,
  provider: P,
): id is ModelIdFor<P> {
  return MODEL_REGISTRY[id] === provider;
}

/**
 * Look up a registry provider by served/reported id. Returns `undefined` for ids
 * the registry doesn't track (provider dated aliases like `gemini-2.5-pro-002`,
 * transcription models).
 */
export function findModelProvider(id: string): ModelProviderId | undefined {
  return isModelId(id) ? MODEL_REGISTRY[id] : undefined;
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
