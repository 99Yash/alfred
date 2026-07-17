import {
  embed,
  generateText,
  Output,
  streamText,
  type EmbedResult,
  type GenerateTextResult,
  type LanguageModel,
  type LanguageModelUsage,
  type StreamTextResult,
  type ToolSet,
} from "ai";
import { identifyLanguageModel } from "../models";
import { metered, meteredStream } from "./metered";
import type { CallAttribution, MeteredMeta, MeteredResult } from "./types";
import { toMessage } from "@alfred/contracts";

/**
 * AI-SDK call wrappers — thin sugar over `metered()`. They:
 *   1. Call the underlying SDK function with the caller's args.
 *   2. Extract `usage` and a small `responseMeta` shape from the result.
 *   3. Forward provider+model identifiers to the metering layer.
 *
 * Provider/model identifiers are inferred from the `LanguageModel` (which
 * carries `.provider` + `.modelId` since AI SDK v5+). When the SDK no
 * longer exposes them, callers can override via `meta`.
 */

interface ModelIdentifiers {
  provider: string;
  model: string;
}

/**
 * Resolve `{ provider, model }` for the metering meta off a `LanguageModel`.
 * Thin adapter over the shared `identifyLanguageModel` (which returns
 * `{ provider, modelId }`) — the provider-head normalization and SDK-shape
 * narrowing live there, shared with `prices.resolveModelContextWindow`.
 */
function modelIdsFor(model: LanguageModel): ModelIdentifiers {
  const { provider, modelId } = identifyLanguageModel(model);
  return { provider, model: modelId };
}

/**
 * Hard ceiling for any single non-streaming provider call when the caller
 * doesn't set its own `timeout`. A wedged provider socket (connected, no
 * bytes, no error) would otherwise block a worker step forever — and because
 * the agent worker heartbeats `last_checkpoint_at` while `runOnce()` awaits,
 * stale-run recovery can never reclaim it. Bounding every metered call turns a
 * hung provider into a normal error + retry instead of a zombie run.
 *
 * Deliberately generous: background boss-model generates (briefing, triage
 * deepen, skill docs) can legitimately run several minutes. This is a backstop
 * against an infinite hang, not an SLA — latency-sensitive callers still pass a
 * tighter `timeout` (e.g. the 15s chat-title call), which wins over this.
 */
export const DEFAULT_LLM_TIMEOUT_MS = 600_000;

/**
 * Streaming backstop for direct {@link meteredStreamText} callers that don't
 * pass their own `timeout`. A 30s chunk gap means a wedged connection; the
 * total ceiling mirrors {@link DEFAULT_LLM_TIMEOUT_MS}. (The agent's
 * `streamTurn` sets its own tighter default, so this only guards ad-hoc
 * callers.)
 */
const DEFAULT_STREAM_TIMEOUT = { chunkMs: 30_000, totalMs: DEFAULT_LLM_TIMEOUT_MS } as const;

// `metered()` only reads `usage`/`finishReason`/`toolCalls`/`steps`,
// none of which depend on the OUTPUT generic — so we collapse to the
// widest valid instantiation and let the call site cast through `never`.
function extractTextUsage(
  result: GenerateTextResult<ToolSet, never, never>,
  cacheWriteTtl: AttributedCall["cacheWriteTtl"],
): MeteredResult {
  return {
    usage: usageFromSdk(result.usage, cacheWriteTtl),
    responseMeta: {
      finishReason: result.finishReason,
      toolCallCount: result.toolCalls.length,
      stepCount: result.steps?.length,
    },
    // Completion — only sent to Langfuse when capture is on (gated in
    // metering/langfuse.ts). Folds the turn's tool calls in alongside the text:
    // on a tool-call turn the model often emits no prose, so `.text` alone would
    // drop the one thing a trajectory replay needs — what the model decided to
    // call (see captureOutput).
    output: captureOutput({ text: result.text, toolCalls: result.toolCalls }),
    ...servedFromResponse(result.finalStep.response),
  };
}

/**
 * The captured generation output. `result.text` alone is lossy: on a turn that
 * ends in tool calls the model frequently emits no assistant prose, so the
 * trace would record `null`/empty and lose the turn's actual decision. The
 * executed calls do surface later as their own tool spans (#214), but a call
 * that's staged / HIL-gated / rejected never executes and thus never spans — so
 * the model's *decision* is only reliably recoverable here, on the generation.
 *
 * Returns the bare string for a plain final turn or the structured-object path
 * (no tool calls, `.text` carries the JSON) so existing renders and ad-hoc
 * trace I/O mirroring are unchanged; only a tool-call turn gets the object
 * shape with `{ toolName, toolCallId, input }` per proposed call.
 */
export function captureOutput(args: {
  text: string;
  toolCalls?: readonly { toolName: string; toolCallId: string; input: unknown }[];
}): unknown {
  const { text, toolCalls } = args;
  if (toolCalls && toolCalls.length > 0) {
    const calls = toolCalls.map((c) => ({
      toolName: c.toolName,
      toolCallId: c.toolCallId,
      input: c.input,
    }));
    return text ? { text, toolCalls: calls } : { toolCalls: calls };
  }
  return text;
}

/**
 * Build the Langfuse span input from SDK call args. Prefers the chat
 * `messages` array (Langfuse renders it as a conversation); falls back to
 * the `prompt` string, folding in `instructions` when present. Attached to every
 * call's meta but only emitted when `LANGFUSE_CAPTURE_IO=true`.
 */
function captureInput(args: {
  instructions?: unknown;
  prompt?: unknown;
  messages?: unknown;
}): unknown {
  const { instructions, prompt, messages } = args;
  if (Array.isArray(messages)) {
    if (typeof instructions === "string") {
      return [{ role: "system", content: instructions }, ...messages];
    }
    return instructions !== undefined ? [instructions, ...messages] : messages;
  }
  if (prompt !== undefined) return instructions ? { instructions, prompt } : prompt;
  return instructions;
}

/**
 * Pull the served model id off the SDK's response metadata so `metered()`
 * can re-attribute calls a `withFallback` cascade routed to the fallback
 * provider (the pre-call meta still names the primary).
 */
function servedFromResponse(
  response: { modelId?: string } | undefined,
): Pick<MeteredResult, "served"> {
  return response?.modelId ? { served: { model: response.modelId } } : {};
}

function extractEmbedUsage(result: EmbedResult): MeteredResult {
  return {
    usage: { inputTokens: result.usage.tokens, outputTokens: 0 },
    responseMeta: { dim: result.embedding.length },
  };
}

export function usageFromSdk(usage: LanguageModelUsage | undefined, cacheWriteTtl?: "5m" | "1h") {
  if (!usage) return undefined;
  const noCacheTokens = usage.inputTokenDetails?.noCacheTokens;
  const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens;
  const cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens;
  return {
    inputTokens: usage.inputTokens,
    noCacheInputTokens: noCacheTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: cacheReadTokens,
    cacheWriteInputTokens: cacheWriteTokens,
    cacheWriteTtl: cacheWriteTokens != null && cacheWriteTokens > 0 ? cacheWriteTtl : undefined,
  };
}

export type GenerateTextArgs = Parameters<typeof generateText>[0];
export type EmbedArgs = Parameters<typeof embed>[0];

type ObjectSchema<O> = Parameters<typeof Output.object<O>>[0]["schema"];

export interface MeteredGenerateObjectArgs<O> extends Omit<GenerateTextArgs, "output"> {
  schema: ObjectSchema<O>;
  /** Optional name forwarded to `Output.object` — some providers use it for tool/schema naming. */
  schemaName?: string;
  /** Optional description forwarded to `Output.object` — surfaces as additional LLM guidance. */
  schemaDescription?: string;
}

export interface AttributedCall extends CallAttribution {
  /** Trimmed params surfaced to `request_meta` (avoid full prompts). */
  requestMeta?: Record<string, unknown>;
  /** Override provider/model identifiers — only useful for routed/dispatched models. */
  provider?: string;
  model?: string;
  /** Free-form Langfuse span name. Defaults to `${provider}/${model}`. */
  name?: string;
  /** Stable per-call idempotency key. Forwarded to log row + Langfuse trace metadata. */
  idempotencyKey?: string;
  /** Provider cache-write retention used by this request, for TTL-aware billing. */
  cacheWriteTtl?: "5m" | "1h";
}

export async function meteredGenerateText(
  args: GenerateTextArgs,
  attribution: AttributedCall = {},
): Promise<GenerateTextResult<ToolSet, never, never>> {
  const ids = resolveIds(args.model, attribution);
  const meta: MeteredMeta = {
    ...attribution,
    kind: attribution.kind ?? "llm",
    ...ids,
    input: captureInput(args as Parameters<typeof captureInput>[0]),
  };
  const callArgs = withDefaultTimeout(args);
  // The SDK's natural return type is GenerateTextResult<ToolSet, Output<any,…>>
  // but the `Output` interface is not exported as a nameable type, only via a
  // namespace alias. Cast through unknown to a callable shape and pin the
  // public return type to <ToolSet, never>, which downstream callers (which
  // never use structured output) can read freely.
  return metered(meta, () => generateText(callArgs), ((
    result: GenerateTextResult<ToolSet, never, never>,
  ) => extractTextUsage(result, attribution.cacheWriteTtl)) as never) as unknown as Promise<
    GenerateTextResult<ToolSet, never, never>
  >;
}

/**
 * Structured-output wrapper. AI SDK deprecated `generateObject` in favor of
 * `generateText` + `Output.object`, so we route through the text path and
 * while preserving the SDK's native typed `.output` result contract.
 */
export async function meteredGenerateObject<O>(
  args: MeteredGenerateObjectArgs<O>,
  attribution: AttributedCall = {},
): Promise<GenerateTextResult<ToolSet, never, ReturnType<typeof Output.object<O>>>> {
  const { schema, schemaName, schemaDescription, ...rest } = args;
  const ids = resolveIds(rest.model, attribution);
  const meta: MeteredMeta = {
    ...attribution,
    kind: attribution.kind ?? "llm",
    ...ids,
    input: captureInput(rest as Parameters<typeof captureInput>[0]),
  };
  type Result = GenerateTextResult<ToolSet, never, ReturnType<typeof Output.object<O>>>;
  // The discriminated `Prompt` union (prompt | messages) doesn't survive an
  // Omit/spread round trip — TS widens `messages` to `T[] | undefined`. Cast
  // back to the SDK's parameter type so the call type-checks; the original
  // `args` already satisfied the union.
  const callArgs = {
    ...rest,
    timeout: rest.timeout ?? DEFAULT_LLM_TIMEOUT_MS,
    output: Output.object({
      schema,
      name: schemaName,
      description: schemaDescription,
    }),
  } as unknown as Parameters<typeof generateText>[0];
  return (await metered(meta, () => generateText(callArgs), ((
    result: GenerateTextResult<ToolSet, never, never>,
  ) => extractTextUsage(result, attribution.cacheWriteTtl)) as never)) as unknown as Result;
}

export type StreamTextArgs = Parameters<typeof streamText>[0];
type StreamTextEndEvent = Parameters<NonNullable<StreamTextArgs["onEnd"]>>[0];
type StreamTextErrorEvent = Parameters<NonNullable<StreamTextArgs["onError"]>>[0];
type StreamTextAbortEvent = Parameters<NonNullable<StreamTextArgs["onAbort"]>>[0];

/**
 * Streaming counterpart to `meteredGenerateText`. Returns the SDK's
 * `StreamTextResult` synchronously so the caller can consume `stream`
 * for live token / tool-call deltas; metering lands once the stream
 * finishes, via the SDK's `onEnd` / `onError` hooks. Produces exactly
 * one `api_call_log` row per streamed turn, same as the non-streaming path.
 *
 * Any caller-supplied `onEnd` / `onError` are preserved and invoked
 * after the metering hook runs.
 */
export function meteredStreamText(
  args: StreamTextArgs,
  attribution: AttributedCall = {},
): StreamTextResult<ToolSet, never, never> {
  const ids = resolveIds(args.model, attribution);
  const meta: MeteredMeta = {
    ...attribution,
    kind: attribution.kind ?? "llm",
    ...ids,
    input: captureInput(args as Parameters<typeof captureInput>[0]),
  };
  const callerOnEnd = args.onEnd;
  const callerOnError = args.onError;
  const callerOnAbort = args.onAbort;
  const timeout = args.timeout ?? DEFAULT_STREAM_TIMEOUT;
  return meteredStream(meta, ({ finish, fail, abort }) =>
    streamText({
      ...args,
      timeout,
      onEnd: (event: StreamTextEndEvent) => {
        finish({
          usage: usageFromSdk(event.usage, attribution.cacheWriteTtl),
          responseMeta: {
            finishReason: event.finishReason,
            toolCallCount: event.toolCalls.length,
            stepCount: event.steps?.length,
          },
          // Same fold as the non-streaming path: a streamed tool-call turn emits
          // no prose, so capture the proposed calls or the replay loses them.
          output: captureOutput({ text: event.text, toolCalls: event.toolCalls }),
          ...servedFromResponse(event.finalStep.response),
        });
        callerOnEnd?.(event);
      },
      onError: (event: StreamTextErrorEvent) => {
        fail(toMessage(event.error));
        callerOnError?.(event);
      },
      onAbort: (event: StreamTextAbortEvent) => {
        // No top-level `response` on an abort, so mine the served model id
        // off the last finished step — otherwise a stop/timeout after a
        // `withFallback` cascade gets logged as the nominal primary (#216).
        const served = servedFromSteps(event.steps);
        abort({
          usage: usageFromSteps(event.steps, attribution.cacheWriteTtl),
          responseMeta: {
            finishReason: "abort",
            stepCount: event.steps.length,
            ...(served.served ? {} : { servedModelUnknown: true }),
          },
          ...served,
        });
        callerOnAbort?.(event);
      },
    }),
  ) as StreamTextResult<ToolSet, never, never>;
}

/**
 * Latest served model id across finished steps. Walks from the end so the
 * most recent step (the one the cascade landed on) wins; returns `{}` when no
 * step reported a `response.modelId`, so the caller can flag the attribution
 * as unknown rather than silently keeping the pre-call primary.
 */
function servedFromSteps(
  steps: readonly { response?: { modelId?: string } }[],
): Pick<MeteredResult, "served"> {
  for (let i = steps.length - 1; i >= 0; i--) {
    const modelId = steps[i]?.response?.modelId;
    if (modelId) return { served: { model: modelId } };
  }
  return {};
}

export function usageFromSteps(
  steps: readonly { usage?: LanguageModelUsage }[],
  cacheWriteTtl?: "5m" | "1h",
) {
  if (steps.length === 0) return undefined;
  let inputTokens = 0;
  let noCacheInputTokens: number | undefined;
  let outputTokens = 0;
  // Leave undefined when no step reported cache info, matching the
  // non-abort path (`usageFromSdk`) instead of asserting a false `0`.
  let cachedInputTokens: number | undefined;
  let cacheWriteInputTokens: number | undefined;
  let sawUsage = false;
  for (const step of steps) {
    const usage = usageFromSdk(step.usage, cacheWriteTtl);
    if (!usage) continue;
    sawUsage = true;
    inputTokens += usage.inputTokens ?? 0;
    if (usage.noCacheInputTokens != null) {
      noCacheInputTokens = (noCacheInputTokens ?? 0) + usage.noCacheInputTokens;
    }
    outputTokens += usage.outputTokens ?? 0;
    if (usage.cachedInputTokens != null) {
      cachedInputTokens = (cachedInputTokens ?? 0) + usage.cachedInputTokens;
    }
    if (usage.cacheWriteInputTokens != null) {
      cacheWriteInputTokens = (cacheWriteInputTokens ?? 0) + usage.cacheWriteInputTokens;
    }
  }
  if (!sawUsage) return undefined;
  return {
    inputTokens,
    noCacheInputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    cacheWriteTtl:
      cacheWriteInputTokens != null && cacheWriteInputTokens > 0 ? cacheWriteTtl : undefined,
  };
}

export async function meteredEmbed(
  args: EmbedArgs,
  attribution: AttributedCall = {},
): Promise<EmbedResult> {
  const ids = resolveIds(args.model, attribution);
  const meta: MeteredMeta = { ...attribution, kind: "embedding", ...ids };
  // `embed` has no `timeout` param, only `abortSignal` — inject a timeout
  // signal so a hung embedding call can't wedge a worker step forever, same
  // backstop the text wrappers get via `timeout`. Compose (not replace) any
  // caller signal so a stop button still works AND the timeout still fires
  // even if the caller's signal never does (#286 review).
  const timeoutSignal = AbortSignal.timeout(DEFAULT_LLM_TIMEOUT_MS);
  const callArgs: EmbedArgs = {
    ...args,
    abortSignal:
      args.abortSignal !== undefined
        ? AbortSignal.any([args.abortSignal, timeoutSignal])
        : timeoutSignal,
  };
  return metered(meta, () => embed(callArgs), extractEmbedUsage);
}

/**
 * Inject the default backstop {@link DEFAULT_LLM_TIMEOUT_MS} when the caller
 * didn't set a `timeout`. The SDK lets `timeout` and `abortSignal` coexist, so
 * a caller-supplied abort signal (e.g. a stop button) is unaffected.
 */
function withDefaultTimeout(args: GenerateTextArgs): GenerateTextArgs {
  if (args.timeout !== undefined) return args;
  return { ...args, timeout: DEFAULT_LLM_TIMEOUT_MS };
}

function resolveIds(model: unknown, attribution: AttributedCall): ModelIdentifiers {
  if (attribution.provider && attribution.model) {
    return { provider: attribution.provider, model: attribution.model };
  }
  return modelIdsFor(model as LanguageModel);
}
