import { google } from "@ai-sdk/google";
import type { ChatModelTier } from "@alfred/contracts";
import { isCallerAbort } from "./abort";
import { APICallError, generateText, type ToolSet } from "ai";
// ai-retry's `LanguageModel` alias is `LanguageModelV4` — the concrete model
// instances our provider factories return, deliberately narrower than `ai`'s
// `LanguageModel` union (which also admits gateway string ids). Same narrowing
// warden does; see its packages/ai/src/models.ts.
import type { LanguageModel as LanguageModelV4 } from "ai-retry";
import { createRetryableModel, error, or, timeout } from "ai-retry/language-model";
import { MODEL_CAPABILITIES, type ModelId } from "./models";
import {
  createProviderRouteModel,
  type ModelReasoningPolicy,
  providerOptionsForModel,
  type ProviderAdaptedLanguageModel,
} from "./provider-adapter";

// Re-export so existing `@alfred/ai` consumers keep importing `ChatModelTier`
// from here; the literal itself is owned by `@alfred/contracts` (single source
// of truth shared with the web bundle, which can't import `@alfred/ai`).
export type { ChatModelTier };

type ChatProviderOptions = NonNullable<Parameters<typeof generateText>[0]["providerOptions"]>;

type ModelChain = readonly [ModelId, ...ModelId[]];
interface ModelRoute {
  readonly chain: ModelChain;
  readonly reasoning: ModelReasoningPolicy;
}

/**
 * Product model routes. A route is the model chain plus the reasoning policy
 * that must travel with every leg. Adding a fallback is one edit to `chain`;
 * model composition and provider-option projection both fold that same tuple.
 */
const MODEL_ROUTES = {
  boss: {
    chain: ["claude-sonnet-4-6", "gemini-2.5-flash"],
    reasoning: "medium",
  },
  subAgent: {
    chain: ["claude-sonnet-4-6", "gemini-2.5-flash"],
    reasoning: "medium",
  },
  cheap: {
    chain: ["gemini-2.5-flash-lite", "gemini-2.5-flash"],
    reasoning: "disabled",
  },
  webSearch: {
    chain: ["gemini-2.5-flash"],
    reasoning: "disabled",
  },
  compactor: {
    chain: ["claude-sonnet-4-6"],
    reasoning: "disabled",
  },
  compactorFallback: {
    chain: ["gemini-2.5-flash"],
    reasoning: "disabled",
  },
  standard: {
    chain: ["claude-sonnet-4-6", "gemini-2.5-flash"],
    reasoning: "medium",
  },
  deep: {
    chain: ["claude-opus-4-8", "gemini-2.5-flash"],
    reasoning: "high",
  },
} as const satisfies Record<string, ModelRoute>;

export type ModelRouteName = keyof typeof MODEL_ROUTES;

export interface ModelRouteHandle {
  model(): ProviderAdaptedLanguageModel;
  providerOptions(): ChatProviderOptions;
}

function mergeRouteProviderOptions(definition: ModelRoute): ChatProviderOptions {
  const merged: ChatProviderOptions = {};
  for (const modelId of definition.chain) {
    const next = providerOptionsForModel(modelId, definition.reasoning);
    for (const [provider, options] of Object.entries(next)) {
      const previous = merged[provider];
      if (previous && JSON.stringify(previous) !== JSON.stringify(options)) {
        throw new Error(
          `route maps multiple ${provider} models with incompatible provider options`,
        );
      }
      merged[provider] = options;
    }
  }
  return merged;
}

function createRouteHandle(definition: ModelRoute): ModelRouteHandle {
  const providerOptions = mergeRouteProviderOptions(definition);
  let model: ProviderAdaptedLanguageModel | undefined;
  return {
    model: () =>
      (model ??= createProviderRouteModel(definition.chain, withFallback, providerOptions)),
    providerOptions: () => providerOptions,
  };
}

const namedRouteHandles = new Map<ModelRouteName, ModelRouteHandle>();

function isModelRouteName(value: ModelRouteName | ModelId): value is ModelRouteName {
  return Object.hasOwn(MODEL_ROUTES, value);
}

/**
 * Resolve a named product route, or build a one-model probe/eval route with an
 * explicit reasoning policy. Both forms return the same paired route handle.
 */
export function route(name: ModelRouteName): ModelRouteHandle;
export function route(modelId: ModelId, reasoning: ModelReasoningPolicy): ModelRouteHandle;
export function route(
  nameOrModelId: ModelRouteName | ModelId,
  reasoning?: ModelReasoningPolicy,
): ModelRouteHandle {
  if (isModelRouteName(nameOrModelId)) {
    let handle = namedRouteHandles.get(nameOrModelId);
    if (!handle) {
      handle = createRouteHandle(MODEL_ROUTES[nameOrModelId]);
      namedRouteHandles.set(nameOrModelId, handle);
    }
    return handle;
  }
  if (!reasoning) throw new Error(`registered model route ${nameOrModelId} needs reasoning policy`);
  return createRouteHandle({ chain: [nameOrModelId], reasoning });
}

const MEDIA_ENRICHMENT_ROUTES = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "claude-sonnet-4-6",
] as const satisfies readonly ModelId[];

export function mediaEnrichmentModelRoutes(
  modality: import("./models").MediaInputModality,
  byteSize: number,
): ModelId[] {
  if (!Number.isInteger(byteSize) || byteSize < 0) throw new Error("byteSize must be non-negative");
  return MEDIA_ENRICHMENT_ROUTES.filter((id) => {
    const capabilities = MODEL_CAPABILITIES[id];
    const inputModalities: readonly import("./models").MediaInputModality[] =
      capabilities.inputModalities;
    return inputModalities.includes(modality) && byteSize <= capabilities.maxInlineMediaBytes;
  });
}

/** Ordered multimodal routes, filtered before any provider receives the payload. */
export function getMediaEnrichmentModels(
  modality: import("./models").MediaInputModality,
  byteSize: number,
): ProviderAdaptedLanguageModel[] {
  const routes = mediaEnrichmentModelRoutes(modality, byteSize);
  if (routes.length === 0) throw new Error("media_enrichment_input_unsupported");
  return routes.map((modelId) => route(modelId, "disabled").model());
}

/**
 * Provider tool set that turns on live Google Search grounding. Pass into the
 * `tools` field of a `meteredGenerateText` call alongside
 * `route("webSearch").model()`; the model searches server-side and returns a
 * grounded answer with source uris + citation spans under
 * `providerMetadata.google.groundingMetadata`.
 */
export function googleSearchGroundingTools(): ToolSet {
  // The SDK over-narrows a provider tool's input schema to `never` inside the
  // non-generic `ToolSet`, so the concrete grounding tool needs a cast — the
  // same `as ToolSet` shape `resolveSdkTools` uses for our function tools.
  // SAFETY: the built object is one SDK provider tool under its own key, which
  // is exactly the ToolSet record shape.
  return { google_search: google.tools.googleSearch({}) } as ToolSet;
}

/**
 * Wrap a primary model so a failed call degrades to `fallback` (warden's
 * `createRetryable` pattern — memory `feedback_ai_retry_preference`; the
 * earlier V2/V3 spec-mismatch blocker cleared with `@ai-sdk/*@3.0.x`, which
 * emit `LanguageModelV4`).
 *
 * Cascade, evaluated per failed attempt:
 *   1. Transient errors (provider-flagged retryable — 429/529/overload — or
 *      timeout) retry the primary once after a short delay, honoring
 *      `Retry-After` headers.
 *   2. Anything else switches to `fallback` for a single attempt — EXCEPT a
 *      non-retryable 4xx client error, which means OUR request is malformed
 *      (e.g. an illegal tool name) rather than the provider being down.
 *      Switching providers on a 4xx just hides the bug behind a weaker model:
 *      that is exactly how the dotted-tool-name 400 silently ran the chat boss
 *      on Gemini for weeks. A 4xx (other than 408/429, which are transient and
 *      a legit reason to try the other provider) now surfaces loudly instead.
 *      A caller-initiated abort is excluded for a different reason: the request
 *      was cancelled on purpose, so there is nothing to degrade to.
 *
 * Streaming caveat: fallback only covers errors raised before the stream
 * starts; a provider dying mid-stream after tokens flowed is not replayable.
 *
 * Attribution: the returned model proxies `provider`/`modelId` to whichever
 * model is *currently* serving, and the metering layer records the served
 * model from the response (`served` in `MeteredResult`), so `api_call_log`
 * stays correct when the fallback fires.
 */
/**
 * True when a 4xx is a billing/quota *capacity* condition (a workspace spend
 * cap, exhausted credits, or a usage-limit ceiling) rather than a malformed
 * request. Anthropic surfaces the workspace spend cap as a 400 whose body
 * carries the signature message "...workspace API usage limits..."; out-of-
 * credit and usage-limit errors read similarly ("credit balance is too low",
 * "usage limit"). These should degrade to the fallback like a 429, not
 * hard-fail the turn (#303).
 *
 * Matches defensively across the parsed message and the raw response body so a
 * provider tweak to either field still trips the carve-out, and the phrases are
 * specific enough not to catch a request-shape 4xx (illegal tool name, bad
 * schema), which must keep surfacing loudly.
 */
function isQuotaOrBillingError(e: APICallError): boolean {
  const haystack = `${e.message} ${e.responseBody ?? ""}`.toLowerCase();
  return (
    haystack.includes("usage limit") ||
    haystack.includes("credit balance") ||
    haystack.includes("billing")
  );
}

export function withFallback(primary: LanguageModelV4, fallback: LanguageModelV4): LanguageModelV4 {
  // True for any error worth degrading to the fallback; false for a
  // non-retryable client bug we want to surface. Built with the raw `error`
  // helper (not `.not()`) so it is inherently error-only — `.not()` of an error
  // condition also matches *successful* results, which the retry loop consults.
  const shouldSwitch = error((e) => {
    // A caller-initiated cancel is never a capacity condition — the request was
    // abandoned deliberately (a hedged-request loser, a stop button, shutdown),
    // so re-issuing it on the fallback bills a second call for an answer nobody
    // is waiting for. Without this, the triage hedge (#436) would have made
    // every cancelled duplicate fan out to `gemini-2.5-flash`.
    if (isCallerAbort(e)) return false;
    if (APICallError.isInstance(e) && e.statusCode !== undefined) {
      const code = e.statusCode;
      const isClientBug = code >= 400 && code < 500 && code !== 408 && code !== 429;
      // A spend-cap / workspace-usage-limit error is a *capacity* condition we
      // want to degrade through, but Anthropic returns it as a 4xx billing
      // error (not 408/429), so the generic client-bug guard would surface it
      // and hard-fail the turn (#303). Carve it out so it degrades like a 429,
      // while genuine request-shape 4xx (dotted tool name, malformed schema)
      // still surface loudly.
      if (isClientBug && !isQuotaOrBillingError(e)) return false;
    }
    return true;
  });
  return createRetryableModel({
    model: primary,
    retries: [
      or(error.isRetryable(true), timeout()).retry({ delay: 1_000, maxAttempts: 2 }),
      shouldSwitch.switch({ model: fallback }),
    ],
  });
}
