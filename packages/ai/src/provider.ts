import { google } from "@ai-sdk/google";
import type { SharedV4ProviderOptions } from "@ai-sdk/provider";
import { chatEffortSchema, type ChatEffort, type ChatModelTier } from "@alfred/contracts";
import { findApiCallError, isCallerAbort } from "./abort";
import { APICallError, type ToolSet } from "ai";
// Narrower than `ai`'s `LanguageModel`, which also admits gateway string ids.
import type { LanguageModel as LanguageModelV4 } from "ai-retry";
import { createRetryableModel, error, or, timeout } from "ai-retry/language-model";
import {
  anthropicLeg,
  createProviderRouteModel,
  googleLeg,
  openAiLeg,
  type RouteLeg,
  type RouteReasoning,
} from "./provider-adapter";
import { identifyLanguageModel } from "./models";

export type { ChatModelTier };

export type ChatProviderOptions = SharedV4ProviderOptions;

export const MEDIA_INPUT_MODALITIES = ["text", "image", "audio", "video", "pdf"] as const;

export type MediaInputModality = (typeof MEDIA_INPUT_MODALITIES)[number];

/** The generic `reasoning` setting never turns on Google thought summaries, so ask for them here. */
const GOOGLE_THOUGHT_SUMMARIES = {
  google: { thinkingConfig: { includeThoughts: true } },
} as const satisfies SharedV4ProviderOptions;

interface ModelRoute {
  /** In fallback order. */
  readonly legs: readonly (() => RouteLeg)[];
  /** The provider package maps and clamps it. */
  readonly reasoning: RouteReasoning;
  /** What the generic reasoning setting cannot express, for example OpenAI `max`. */
  readonly providerOptions?: SharedV4ProviderOptions;
}

/** Product model routes: ordered legs plus the reasoning level every leg gets. */
const MODEL_ROUTES = {
  // Background work: briefings, triage deepen, cold start, skill compose.
  boss: {
    legs: [() => openAiLeg("gpt-6-luna"), () => googleLeg("gemini-3.8-flash")],
    reasoning: "medium",
    providerOptions: GOOGLE_THOUGHT_SUMMARIES,
  },
  // Same model as chat, so a delegating turn stays on one vendor.
  subAgent: {
    legs: [() => openAiLeg("gpt-6-luna"), () => googleLeg("gemini-3.8-flash")],
    reasoning: "medium",
    providerOptions: GOOGLE_THOUGHT_SUMMARIES,
  },
  cheap: {
    legs: [() => googleLeg("gemini-2.5-flash-lite"), () => googleLeg("gemini-3.8-flash")],
    reasoning: "none",
  },
  webSearch: {
    legs: [() => googleLeg("gemini-3.8-flash")],
    reasoning: "none",
  },
  compactor: {
    legs: [() => anthropicLeg("claude-sonnet-4-6")],
    reasoning: "none",
  },
  compactorFallback: {
    legs: [() => googleLeg("gemini-3.8-flash")],
    reasoning: "none",
  },
  // The chat tiers differ only in effort.
  standard: {
    legs: [() => openAiLeg("gpt-6-luna"), () => googleLeg("gemini-3.8-flash")],
    reasoning: "medium",
    providerOptions: GOOGLE_THOUGHT_SUMMARIES,
  },
  // `xhigh` is the generic ceiling. OpenAI gets its provider-only `max`; Gemini maps `xhigh` to `high`.
  deep: {
    legs: [() => openAiLeg("gpt-6-luna"), () => googleLeg("gemini-3.8-flash")],
    reasoning: "xhigh",
    providerOptions: { ...GOOGLE_THOUGHT_SUMMARIES, openai: { reasoningEffort: "max" } },
  },
} as const satisfies Record<string, ModelRoute>;

export type ModelRouteName = keyof typeof MODEL_ROUTES;

export interface ModelRouteHandle {
  model(): LanguageModelV4;
  /** Only the exceptions. The generic reasoning is already on the model. */
  providerOptions(): ChatProviderOptions;
  reasoning(): RouteReasoning;
}

function createRouteHandle(definition: ModelRoute): ModelRouteHandle {
  const providerOptions: ChatProviderOptions = definition.providerOptions ?? {};
  let model: LanguageModelV4 | undefined;

  return {
    model: () =>
      (model ??= createProviderRouteModel(definition.legs, withFallback, {
        reasoning: definition.reasoning,
        ...(definition.providerOptions ? { providerOptions: definition.providerOptions } : {}),
      })),
    providerOptions: () => providerOptions,
    reasoning: () => definition.reasoning,
  };
}

const namedRouteHandles = new Map<ModelRouteName, ModelRouteHandle>();

/** Memoized per name. */
export function route(name: ModelRouteName): ModelRouteHandle {
  let handle = namedRouteHandles.get(name);

  if (!handle) {
    handle = createRouteHandle(MODEL_ROUTES[name]);
    namedRouteHandles.set(name, handle);
  }

  return handle;
}

/** A one-leg route for probes and evals. Not memoized. */
export function probeRoute(leg: RouteLeg, reasoning: RouteReasoning): ModelRouteHandle {
  return createRouteHandle({ legs: [() => leg], reasoning });
}

/** The route's effort as a displayable level. Throws on `provider-default`, which is not a level. */
export function routeEffort(name: ModelRouteName): ChatEffort {
  const reasoning = route(name).reasoning();
  const parsed = chatEffortSchema.safeParse(reasoning);

  if (!parsed.success) throw new Error(`route "${name}" selects a non-level reasoning effort`);

  return parsed.data;
}

interface MediaEnrichmentLeg {
  readonly modalities: readonly MediaInputModality[];
  readonly maxInlineBytes: number;
  readonly make: () => LanguageModelV4;
}

/** Largest inline attachment each provider reads natively. Larger ones degrade to text. */
const GOOGLE_INLINE_MEDIA_BYTES = 50 * 1024 * 1024;

const ANTHROPIC_INLINE_MEDIA_BYTES = 32 * 1024 * 1024;

/** Multimodal legs in attempt order. */
const MEDIA_ENRICHMENT_LEGS: readonly MediaEnrichmentLeg[] = [
  {
    modalities: ["text", "image", "audio", "video", "pdf"],
    maxInlineBytes: GOOGLE_INLINE_MEDIA_BYTES,
    make: () => withDisabledReasoning(googleLeg("gemini-3.8-flash")),
  },
  {
    modalities: ["text", "image", "audio", "video"],
    maxInlineBytes: GOOGLE_INLINE_MEDIA_BYTES,
    make: () => withDisabledReasoning(googleLeg("gemini-2.5-flash")),
  },
  {
    modalities: ["text", "image", "audio", "video", "pdf"],
    maxInlineBytes: GOOGLE_INLINE_MEDIA_BYTES,
    make: () => withDisabledReasoning(googleLeg("gemini-2.5-flash-lite")),
  },
  {
    modalities: ["text", "image", "pdf"],
    maxInlineBytes: ANTHROPIC_INLINE_MEDIA_BYTES,
    make: () => withDisabledReasoning(anthropicLeg("claude-sonnet-4-6")),
  },
];

/** Reasoning `none`. Gemini 3 cannot fully disable thinking, so it gets its minimum level. */
function withDisabledReasoning(leg: RouteLeg): LanguageModelV4 {
  return createProviderRouteModel([() => leg], withFallback, { reasoning: "none" });
}

/** The legs that can read this payload, in attempt order. */
export function getMediaEnrichmentModels(
  modality: MediaInputModality,
  byteSize: number,
): LanguageModelV4[] {
  if (!Number.isInteger(byteSize) || byteSize < 0) throw new Error("byteSize must be non-negative");

  const models = MEDIA_ENRICHMENT_LEGS.filter(
    (leg) => leg.modalities.includes(modality) && byteSize <= leg.maxInlineBytes,
  ).map((leg) => leg.make());

  if (models.length === 0) throw new Error("media_enrichment_input_unsupported");

  return models;
}

/**
 * Google Search grounding. Use with `route("webSearch")`.
 * Sources land in `providerMetadata.google.groundingMetadata`.
 */
export function googleSearchGroundingTools(): ToolSet {
  return { google_search: google.tools.googleSearch({}) };
}

/**
 * The newest provider error in `err` names a spend cap, exhausted usage limit, or credit
 * balance. Money does not refill on a backoff, so this is never capacity. Anthropic sends
 * its workspace spend cap as a 400. Checks both message and body.
 * Provider routing and the chat failure taxonomy both read this, so keep one phrase list.
 */
export function isQuotaOrBillingError(err: unknown): boolean {
  const apiError = findApiCallError(err);

  if (!apiError) return false;
  const haystack = `${apiError.message} ${apiError.responseBody ?? ""}`.toLowerCase();

  return (
    haystack.includes("usage limit") ||
    haystack.includes("credit balance") ||
    haystack.includes("billing")
  );
}

/**
 * A 429, 408, or 5xx worth waiting for (`afterCapacityError`). Status only, no message
 * matching (ADR-0072), so a fault that never clears cannot park a run.
 * Quota and billing errors are excluded: money does not refill on a backoff.
 */
export function isCapacityError(err: unknown): boolean {
  const apiError = findApiCallError(err);

  if (!apiError || apiError.statusCode === undefined) return false;
  const code = apiError.statusCode;

  if (code !== 429 && code !== 408 && code < 500) return false;

  return !isQuotaOrBillingError(apiError);
}

/**
 * Retry the primary on transient errors, then switch to `fallback`.
 * A plain 4xx does not switch: it means our request is wrong, and a weaker model would hide the bug.
 * Fallback covers only errors raised before a stream starts.
 *
 * Stateless on purpose: it builds a new retryable model per call. ai-retry keeps the serving leg
 * in an instance field, so concurrent calls on one memoized route sent retries to the wrong leg.
 *
 * `provider` and `modelId` always name the primary. Use `providerForServedModel` with
 * `result.response.modelId` to learn which leg answered.
 */
export function withFallback(primary: LanguageModelV4, fallback: LanguageModelV4): LanguageModelV4 {
  // Raw `error`, not `.not()`: `.not()` of an error condition also matches successful results.
  const shouldSwitch = error((e) => {
    // A deliberate cancel (hedge loser, stop button) must not bill a second call.
    if (isCallerAbort(e)) return false;

    if (APICallError.isInstance(e) && e.statusCode !== undefined) {
      // A 429 switches, but a gateway `2018` budget 429 is shared across providers,
      // so the fallback rarely escapes it. A provider's own account limit it does escape.
      const code = e.statusCode;
      const isClientBug = code >= 400 && code < 500 && code !== 408 && code !== 429;

      // A spend cap arrives as a 4xx but is capacity, so it switches like a 429.
      if (isClientBug && !isQuotaOrBillingError(e)) return false;
    }

    return true;
  });

  const compose = (): LanguageModelV4 =>
    createRetryableModel({
      model: primary,
      retries: [
        or(error.isRetryable(true), timeout()).retry({ delay: 1_000, maxAttempts: 2 }),
        shouldSwitch.switch({ model: fallback }),
      ],
    });

  return {
    specificationVersion: primary.specificationVersion,
    provider: primary.provider,
    modelId: primary.modelId,
    // Either leg can serve, so accept what either accepts.
    supportedUrls: mergeSupportedUrls(primary.supportedUrls, fallback.supportedUrls),
    doGenerate: (options) => compose().doGenerate(options),
    doStream: (options) => compose().doStream(options),
  };
}

/** Union of both legs' URL patterns. Await covers both a record and a promise of one. */
function mergeSupportedUrls(
  primary: LanguageModelV4["supportedUrls"],
  fallback: LanguageModelV4["supportedUrls"],
): LanguageModelV4["supportedUrls"] {
  return (async () => {
    const [a, b] = await Promise.all([primary, fallback]);
    const merged: Record<string, RegExp[]> = {};

    for (const record of [a, b]) {
      for (const [kind, patterns] of Object.entries(record)) {
        merged[kind] = [...(merged[kind] ?? []), ...patterns];
      }
    }

    return merged;
  })();
}

/** Every leg of every route, for the boot guard. A route facade reports only its primary. */
export function allRouteLegIdentifiers(): Array<{
  route: string;
  provider: string;
  model: string;
}> {
  const seen = new Set<string>();
  const identifiers: Array<{ route: string; provider: string; model: string }> = [];

  const add = (route: string, provider: string, model: string): void => {
    const key = `${provider}/${model}`;

    if (seen.has(key)) return;
    seen.add(key);
    identifiers.push({ route, provider, model });
  };

  for (const [name, definition] of Object.entries(MODEL_ROUTES)) {
    for (const makeLeg of definition.legs) {
      const leg = makeLeg();
      add(name, leg.provider, leg.modelId);
    }
  }

  for (const entry of MEDIA_ENRICHMENT_LEGS) {
    const { provider, modelId } = identifyLanguageModel(entry.make());
    add("media_enrichment", provider, modelId);
  }

  return identifiers;
}
