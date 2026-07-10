import { anthropic, type AnthropicLanguageModelOptions } from "@ai-sdk/anthropic";
import { google, type GoogleLanguageModelOptions } from "@ai-sdk/google";
import { openai, type OpenAILanguageModelResponsesOptions } from "@ai-sdk/openai";
import type { ChatModelTier } from "@alfred/contracts";
import { APICallError, generateText, type LanguageModel, type ToolSet } from "ai";
// ai-retry's `LanguageModel` alias is `LanguageModelV4` — the concrete model
// instances our provider factories return, deliberately narrower than `ai`'s
// `LanguageModel` union (which also admits gateway string ids). Same narrowing
// warden does; see its packages/ai/src/models.ts.
import type { LanguageModel as LanguageModelV4 } from "ai-retry";
import { createRetryableModel, error, or, timeout } from "ai-retry/language-model";
import {
  type EffortLevel,
  EFFORT_LEVELS,
  MODEL_CAPABILITIES,
  type ModelId,
  type ModelIdFor,
  isModelIdForProvider,
  MODEL_REGISTRY,
  type ModelProviderId,
} from "./models";
import { withToolNameShim } from "./tool-name-shim";

// Re-export so existing `@alfred/ai` consumers keep importing `ChatModelTier`
// from here; the literal itself is owned by `@alfred/contracts` (single source
// of truth shared with the web bundle, which can't import `@alfred/ai`).
export type { ChatModelTier };

type AnthropicChatProviderOptions = Pick<AnthropicLanguageModelOptions, "thinking" | "effort">;
type GoogleChatProviderOptions = Pick<GoogleLanguageModelOptions, "thinkingConfig">;
type OpenAIChatProviderOptions = Pick<OpenAILanguageModelResponsesOptions, "reasoningEffort">;
type AnthropicEffortLevel = NonNullable<AnthropicChatProviderOptions["effort"]>;
type ChatProviderOptions = NonNullable<Parameters<typeof generateText>[0]["providerOptions"]>;
type ToolNameProviderPolicy = {
  readonly toolNameShim: boolean;
  readonly toolNameMaxLen: number;
};

export const TOOL_NAME_PROVIDER_POLICIES = {
  anthropic: { toolNameShim: true, toolNameMaxLen: 128 },
  google: { toolNameShim: true, toolNameMaxLen: 64 },
  openai: { toolNameShim: true, toolNameMaxLen: 64 },
} as const satisfies Record<ModelProviderId, ToolNameProviderPolicy>;

/**
 * Per-provider request mechanics (ADR-0078) — the structural quirks that live on
 * the provider/SDK-adapter axis, not the per-model axis (that's `MODEL_CAPABILITIES`
 * in `models.ts`). This is the one place a tier→model remap routes through, so it
 * can't reintroduce an unsupported reasoning param or a tool-name 400.
 *
 * Keyed by `ModelProviderId`. Conceptually the key is the *SDK adapter* (the same
 * Claude model has different option shapes across `@ai-sdk/anthropic`,
 * `@ai-sdk/amazon-bedrock`, `@ai-sdk/google-vertex/anthropic`); Alfred is 1:1
 * provider↔adapter today, so provider-keying is correct now — a future
 * Bedrock/Vertex adapter would need its own entry.
 */
interface ProviderDispatch {
  /**
   * Apply the `.`↔`__` tool-name shim at this provider's edge. `true` for both
   * dispatched language-model providers today (Anthropic rejects `.`, Google
   * strips the prefix).
   */
  readonly toolNameShim: boolean;
  /** Max tool-name length the provider accepts; pinned by the tool-name registry invariant test. */
  readonly toolNameMaxLen: number;
  /**
   * Build the AI-SDK reasoning/thinking block for `modelId` at the requested
   * `effort`. Owns the block SHAPE; reads the model's `effortValues` and clamps,
   * so a model with no effort param (`effortValues: []`) gets a light/empty block
   * instead of an unsupported param. Return type is per-provider (covariant under
   * the `satisfies` below) so the call sites keep the SDK-typed block.
   */
  reasoningOptions(modelId: ModelId, effort: EffortLevel): Record<string, unknown>;
}

/**
 * Snap a requested effort to the nearest value `allowed` actually contains, by
 * position in {@link EFFORT_LEVELS}. Callers gate on `allowed.length > 0`, so the
 * reduce always has a seed; it never emits a tier the model would 400 on.
 */
export function clampEffort(desired: EffortLevel, allowed: readonly EffortLevel[]): EffortLevel {
  const target = EFFORT_LEVELS.indexOf(desired);
  return allowed.reduce((best, cur) =>
    Math.abs(EFFORT_LEVELS.indexOf(cur) - target) < Math.abs(EFFORT_LEVELS.indexOf(best) - target)
      ? cur
      : best,
  );
}

function isAnthropicEffortLevel(value: EffortLevel): value is AnthropicEffortLevel {
  return value !== "none" && value !== "minimal";
}

const PROVIDER_DISPATCH = {
  anthropic: {
    ...TOOL_NAME_PROVIDER_POLICIES.anthropic,
    reasoningOptions(modelId: ModelId, effort: EffortLevel): AnthropicChatProviderOptions {
      const { effortValues } = MODEL_CAPABILITIES[modelId];
      // Empty block: Haiku 4.5 (ADR-0077) hard-400s on BOTH adaptive thinking and
      // `effort` — they're Sonnet-4.6+/Opus-only. Any model with no effort param
      // gets the light, fast interactive default.
      if (effortValues.length === 0) return {};
      const clampedEffort = clampEffort(effort, effortValues);
      if (!isAnthropicEffortLevel(clampedEffort)) {
        throw new Error(
          `${modelId} declares Anthropic-incompatible effort value "${clampedEffort}"`,
        );
      }
      return {
        thinking: { type: "adaptive", display: "summarized" },
        effort: clampedEffort,
      };
    },
  },
  google: {
    ...TOOL_NAME_PROVIDER_POLICIES.google,
    // `includeThoughts` surfaces the thought summary (not the raw chain);
    // `thinkingBudget: -1` lets Gemini 2.5 size its own thinking. Current Google
    // registry entries are budget/toggle based, so `effort` is intentionally not
    // translated. If a future Google model exposes effort labels (e.g. Gemini 3),
    // this must grow the SDK-specific mapping instead of silently sending the
    // Gemini 2.5 budget block.
    reasoningOptions(modelId: ModelId, _effort: EffortLevel): GoogleChatProviderOptions {
      const { effortValues } = MODEL_CAPABILITIES[modelId];
      if (effortValues.length > 0) {
        throw new Error(
          `${modelId} declares Google effort values [${effortValues.join(",")}], but the Google dispatch only supports budget-based thinkingConfig today`,
        );
      }
      return { thinkingConfig: { includeThoughts: true, thinkingBudget: -1 } };
    },
  },
  openai: {
    ...TOOL_NAME_PROVIDER_POLICIES.openai,
    reasoningOptions(modelId: ModelId, effort: EffortLevel): OpenAIChatProviderOptions {
      const { effortValues } = MODEL_CAPABILITIES[modelId];
      if (effortValues.length === 0) {
        throw new Error(`${modelId} has no OpenAI reasoning-effort vocabulary`);
      }
      return { reasoningEffort: clampEffort(effort, effortValues) };
    },
  },
} as const satisfies Record<ModelProviderId, ProviderDispatch>;

export function getShimmedToolNameMaxLen(): number {
  return Math.min(
    ...Object.values(PROVIDER_DISPATCH)
      .filter((profile) => profile.toolNameShim)
      .map((profile) => profile.toolNameMaxLen),
  );
}

// Provider factories constrained to ids that actually exist in MODEL_REGISTRY
// for that provider. Routing every `anthropic(...)`/`google(...)` literal
// through these makes registry drift (a typo, or an id the registry never
// listed) a compile error rather than a silent cost-attribution miss.
// Each is wrapped in the tool-name boundary shim per `PROVIDER_DISPATCH`'s
// `toolNameShim` policy so our dotted `integration.action` tool names survive a
// provider that can't carry the `.` (Anthropic rejects it; Google strips the
// prefix). The shim is a no-op on tool-less calls, so routing the whole factory
// through it is safe and uniform.
const anthropicModel = (id: ModelIdFor<"anthropic">) =>
  PROVIDER_DISPATCH.anthropic.toolNameShim ? withToolNameShim(anthropic(id)) : anthropic(id);
const googleModel = (id: ModelIdFor<"google">) =>
  PROVIDER_DISPATCH.google.toolNameShim ? withToolNameShim(google(id)) : google(id);
const openaiModel = (id: ModelIdFor<"openai">) =>
  PROVIDER_DISPATCH.openai.toolNameShim
    ? withToolNameShim(openai.responses(id))
    : openai.responses(id);

function assertModelProvider<P extends ModelProviderId>(
  id: ModelId,
  provider: P,
): asserts id is ModelIdFor<P> {
  if (!isModelIdForProvider(id, provider)) {
    throw new Error(`${id} is registered to ${MODEL_REGISTRY[id]}, not ${provider}`);
  }
}

function providerForModel(id: ModelId): ModelProviderId {
  return MODEL_REGISTRY[id];
}

function modelForId(id: ModelId): LanguageModelV4 {
  const provider = providerForModel(id);
  switch (provider) {
    case "anthropic":
      assertModelProvider(id, "anthropic");
      return anthropicModel(id);
    case "google":
      assertModelProvider(id, "google");
      return googleModel(id);
    case "openai":
      assertModelProvider(id, "openai");
      return openaiModel(id);
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
}

/** Construct any language model in Alfred's closed registry. */
export function getRegisteredModel(id: ModelId): LanguageModel {
  return modelForId(id);
}

/** Provider-namespaced reasoning options for an explicitly selected registry model. */
export function getRegisteredModelProviderOptions(
  id: ModelId,
  effort: EffortLevel,
): ChatProviderOptions {
  const provider = MODEL_REGISTRY[id];
  return { [provider]: PROVIDER_DISPATCH[provider].reasoningOptions(id, effort) };
}

export type ProviderAvailability = Readonly<Record<ModelProviderId, boolean>>;

/**
 * Filter a candidate chain before construction/dispatch. OpenAI is optional in
 * Alfred's environment, so a missing key must remove it here instead of
 * surfacing as a non-retryable 401 after another provider has already failed.
 */
export function selectAvailableModelIds(
  candidates: readonly ModelId[],
  availability: ProviderAvailability,
): ModelId[] {
  return candidates.filter((id) => availability[MODEL_REGISTRY[id]]);
}

/**
 * Boss + sub-agent run on Anthropic Sonnet 4.6, degrading to Gemini 2.5 Pro
 * on provider failure via `withFallback`. (Restored 2026-06-07 after the
 * temporary 2026-05-21 → 2026-06-01 spend-cap swap to Gemini 2.5 Pro; the
 * Anthropic-specific provider options inside `AlfredAgent` — cacheControl
 * etc. — are namespaced under `providerOptions.anthropic`, so Gemini ignores
 * them when the fallback serves.)
 */
export function getBossModel(): LanguageModel {
  return withFallback(anthropicModel("claude-sonnet-4-6"), googleModel("gemini-2.5-pro"));
}

export function getSubAgentModel(): LanguageModel {
  return withFallback(anthropicModel("claude-sonnet-4-6"), googleModel("gemini-2.5-pro"));
}

export function getCheapModel(): LanguageModel {
  // Flash-Lite is Google's lowest-latency tier — typical p50 is well under
  // a second for the short JSON outputs triage/extraction produce. Switched
  // from `gemini-2.5-flash` after the user flagged label-write lag on a
  // single inbound email; the larger Flash model was the bottleneck, not
  // the pipeline.
  //
  // Wrapped in `withFallback` like every other model getter so a flash-lite
  // capacity blip ("high demand" overload) degrades instead of throwing
  // `AI_RetryError`. Previously the only fallback-less getter: a sustained
  // overload hard-failed triage classification (and reddened the eval gate).
  //
  // Fallback is the larger SAME-PROVIDER tier (gemini-2.5-flash), NOT a
  // cross-provider Anthropic model. The cheap path runs `generateObject` over
  // a nested/optional schema, and Anthropic's structured-output (`Output.object`
  // → `output_config.format.schema`) handles that poorly: it rejects numeric
  // min/max and intermittently returns `AI_NoObjectGeneratedError` on
  // valid-looking JSON. Staying on Google keeps the structured-output mechanism
  // that already works; the bigger Flash pool absorbs flash-lite pressure.
  // (Boss/chat fall back cross-provider to Anthropic because they run
  // `generateText`, not structured object generation — different constraint.)
  return withFallback(googleModel("gemini-2.5-flash-lite"), googleModel("gemini-2.5-flash"));
}

/**
 * Transcript compaction is rare, latency-tolerant, and quality-critical.
 * Keep it decoupled from the cheap tier: a bad handoff corrupts the rest
 * of a long boss run, while the incremental cost is negligible.
 */
export const COMPACTOR_MODEL: LanguageModel = anthropicModel("claude-sonnet-4-6");
export const COMPACTOR_FALLBACK_MODEL: LanguageModel = googleModel("gemini-2.5-flash");

/**
 * Live web-search model for short, agent-driven lookups.
 *
 * Switched 2026-06-12 from Perplexity Sonar Pro to grounded Gemini 2.5 Flash
 * (ADR-0022 amended): the Perplexity account lost billing, and Gemini ships
 * Google Search grounding on the API key we already hold. Flash keeps the
 * interactive lookup fast; grounding is turned on per-call by passing
 * {@link googleSearchGroundingTools} into the `tools` field.
 *
 * Caller must route through `meteredGenerateText` with
 * `attribution.kind = 'web_search'` so `api_call_log` rollups bucket the
 * spend correctly.
 */
export function getWebSearchModel(): LanguageModel {
  return googleModel("gemini-2.5-flash");
}

/**
 * Provider tool set that turns on live Google Search grounding. Pass into the
 * `tools` field of a `meteredGenerateText` call alongside
 * {@link getWebSearchModel}; the model searches server-side and returns a
 * grounded answer with source uris + citation spans under
 * `providerMetadata.google.groundingMetadata`.
 */
export function googleSearchGroundingTools(): ToolSet {
  // The SDK over-narrows a provider tool's input schema to `never` inside the
  // non-generic `ToolSet`, so the concrete grounding tool needs a cast — the
  // same `as ToolSet` shape `resolveSdkTools` uses for our function tools.
  return { google_search: google.tools.googleSearch({}) } as ToolSet;
}

/**
 * The interactive-chat tier table (ADR-0077): the product mapping of a tier to its
 * primary model, its cross-provider fallback, and the effort it requests. This is
 * the *only* place a tier's model is named — `getChatModel` and
 * `getChatProviderOptions` both read it, so the model and its reasoning block can
 * never drift (the #313 seam: a remap here flows into the dispatch automatically).
 *
 *   - `standard` (the Auto tier) → Claude Sonnet 4.6 — the everyday boss. ADR-0077
 *     originally downgraded this to Haiku 4.5 for cost, but the 2026-07-02 Sakshi
 *     production trace proved the prompt-patch strategy did not generalize: repeated
 *     "find more" turns, including a Deep/Opus turn, never reached the web. Auto is
 *     back on the same reasoning-capable model as sub-agents, with `effort: "medium"`
 *     as the latency-friendly default for the charter's model-judged source ladder.
 *   - `deep` → Claude Opus 4.8 — reserved for hard, multi-step turns (and the model
 *     the boss-worker harness runs on when chat fans out). Asks for `effort: "high"`
 *     for deliberate reasoning.
 *
 * Each tier degrades to Gemini 2.5 Pro on Anthropic failure (rate limit, overload,
 * spend cap) via `withFallback`, so a chat turn never hard-fails on a single
 * provider blip.
 */
const CHAT_TIERS = {
  standard: { primary: "claude-sonnet-4-6", fallback: "gemini-2.5-pro", effort: "medium" },
  deep: { primary: "claude-opus-4-8", fallback: "gemini-2.5-pro", effort: "high" },
} as const satisfies Record<
  ChatModelTier,
  { primary: ModelId; fallback: ModelId; effort: EffortLevel }
>;

export function getChatModel(tier: ChatModelTier = "standard"): LanguageModel {
  const { primary, fallback } = CHAT_TIERS[tier];
  return withFallback(modelForId(primary), modelForId(fallback));
}

/**
 * Build the chat model's reasoning block, namespaced per provider, so the stream
 * carries `reasoning-delta` parts the chat UI renders as a "Thinking…" accordion.
 * The SDK passes only the block matching the active model and ignores the rest, so
 * emitting both keeps it correct across the Anthropic⇆Gemini `withFallback` swap.
 *
 * Each block is built by `PROVIDER_DISPATCH[provider].reasoningOptions`, reading
 * the resolved model's `effortValues`. The deleted tier-branch (ADR-0077's #313
 * seam) is now structural: `standard` resolves to Sonnet 4.6 with adaptive medium
 * effort; `deep` resolves to Opus with adaptive high effort. A future tier remap
 * flows through the same table and capability map instead of reintroducing a
 * provider-options branch.
 */
export function getChatProviderOptions(tier: ChatModelTier = "standard"): ChatProviderOptions {
  const { primary, fallback, effort } = CHAT_TIERS[tier];
  const options: ChatProviderOptions = {};
  for (const modelId of [primary, fallback]) {
    const provider = MODEL_REGISTRY[modelId];
    const next = PROVIDER_DISPATCH[provider].reasoningOptions(modelId, effort);
    const prev = options[provider];
    if (prev && JSON.stringify(prev) !== JSON.stringify(next)) {
      throw new Error(
        `${tier} maps multiple ${provider} chat models with incompatible provider options`,
      );
    }
    options[provider] = next;
  }
  return options;
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

export function withFallback(primary: LanguageModelV4, fallback: LanguageModelV4): LanguageModel {
  // True for any error worth degrading to the fallback; false for a
  // non-retryable client bug we want to surface. Built with the raw `error`
  // helper (not `.not()`) so it is inherently error-only — `.not()` of an error
  // condition also matches *successful* results, which the retry loop consults.
  const shouldSwitch = error((e) => {
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
