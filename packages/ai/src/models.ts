import type { LanguageModel } from "ai";
import { z } from "zod";

/**
 * Providers Alfred dispatches to. A closed, hand-enumerated set: adding one is
 * a real code change (new provider factory + `model_prices` rows), not data.
 * `openai` also owns transcription, but its GPT entries below are language
 * models dispatched through the Responses API.
 */
export const PROVIDER_IDS = ["anthropic", "google", "openai"] as const;
export const providerIdSchema = z.enum(PROVIDER_IDS);
export type ProviderId = z.infer<typeof providerIdSchema>;

/** Provider effort labels, weakest to strongest. */
export const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export interface ModelCapabilities {
  readonly effortValues: readonly EffortLevel[];
  readonly temperature: boolean;
}

interface ModelDefinition {
  readonly id: string;
  readonly provider: ProviderId;
  readonly capabilities: ModelCapabilities;
}

/**
 * One source of truth for every code-resident model fact. Runtime ids, provider
 * routing, capability lookup, and their literal types are derived below.
 */
export const MODEL_DEFINITIONS = [
  {
    id: "claude-opus-4-8",
    provider: "anthropic",
    capabilities: {
      effortValues: ["low", "medium", "high", "xhigh", "max"],
      temperature: false,
    },
  },
  {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    capabilities: { effortValues: ["low", "medium", "high", "max"], temperature: true },
  },
  {
    id: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    capabilities: { effortValues: [], temperature: true },
  },
  {
    id: "gemini-3.5-flash",
    provider: "google",
    capabilities: {
      effortValues: ["minimal", "low", "medium", "high"],
      temperature: true,
    },
  },
  {
    id: "gemini-2.5-flash",
    provider: "google",
    capabilities: { effortValues: [], temperature: true },
  },
  {
    id: "gemini-2.5-flash-lite",
    provider: "google",
    capabilities: { effortValues: [], temperature: true },
  },
  {
    id: "gpt-5.6-sol",
    provider: "openai",
    capabilities: {
      effortValues: ["none", "low", "medium", "high", "xhigh", "max"],
      temperature: false,
    },
  },
  {
    id: "gpt-5.6-luna",
    provider: "openai",
    capabilities: {
      effortValues: ["none", "low", "medium", "high", "xhigh", "max"],
      temperature: false,
    },
  },
] as const satisfies readonly [ModelDefinition, ...ModelDefinition[]];

type RegisteredModel = (typeof MODEL_DEFINITIONS)[number];
export type ModelId = RegisteredModel["id"];

function modelIds<const T extends readonly [ModelDefinition, ...ModelDefinition[]]>(
  definitions: T,
) {
  // SAFETY: Array.map preserves tuple order and cardinality; each projection is exactly its id.
  return definitions.map(({ id }) => id) as {
    readonly [K in keyof T]: T[K] extends { readonly id: infer I extends string } ? I : never;
  };
}

export const MODEL_IDS = modelIds(MODEL_DEFINITIONS);
export const modelIdSchema = z.enum(MODEL_IDS);

/**
 * Derived model-id projections. Provider routing and the small set of request-time
 * capabilities stay code-resident; catalog facts such as pricing and context
 * windows remain in `model_prices`.
 */
type ModelRegistry = {
  readonly [D in RegisteredModel as D["id"]]: D["provider"];
};

type ModelCapabilityRegistry = {
  readonly [D in RegisteredModel as D["id"]]: D["capabilities"];
};

function indexModelDefinitions(definitions: typeof MODEL_DEFINITIONS): {
  providers: ModelRegistry;
  capabilities: ModelCapabilityRegistry;
} {
  const providers: Record<string, ProviderId> = {};
  const capabilities: Record<string, ModelCapabilities> = {};
  for (const definition of definitions) {
    providers[definition.id] = definition.provider;
    capabilities[definition.id] = definition.capabilities;
  }
  // SAFETY: both records are populated in one exhaustive pass over the canonical tuple.
  return { providers, capabilities } as {
    providers: ModelRegistry;
    capabilities: ModelCapabilityRegistry;
  };
}

const indexedModels = indexModelDefinitions(MODEL_DEFINITIONS);
export const MODEL_REGISTRY = indexedModels.providers;
export const MODEL_CAPABILITIES = indexedModels.capabilities;

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
 * the registry doesn't track (provider dated aliases like `gemini-3.5-flash-002`,
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
 * `LanguageModel` includes gateway strings and versioned model objects. Every
 * object member exposes `provider` + `modelId`, so a plain `typeof === "object"`
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
