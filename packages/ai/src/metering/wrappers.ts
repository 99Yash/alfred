import {
  embed,
  generateText,
  Output,
  streamText,
  type CallWarning,
  type EmbedResult,
  type FinishReason,
  type GenerateTextResult,
  type LanguageModel,
  type LanguageModelUsage,
  type StreamTextResult,
  type ToolSet,
} from "ai";
import { identifyLanguageModel } from "../models";
import { metered, meteredStream } from "./metered";
import type { CallAttribution, MeteredMeta, MeteredResult } from "./types";

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

// `metered()` only reads `totalUsage`/`finishReason`/`toolCalls`/`steps`,
// none of which depend on the OUTPUT generic — so we collapse to the
// widest valid instantiation and let the call site cast through `never`.
function extractTextUsage(result: GenerateTextResult<ToolSet, never>): MeteredResult {
  return {
    usage: usageFromSdk(result.totalUsage),
    responseMeta: {
      finishReason: result.finishReason,
      toolCallCount: result.toolCalls.length,
      stepCount: result.steps?.length,
    },
    // Full completion text — only sent to Langfuse when capture is on
    // (gated in metering/langfuse.ts). Covers both the text path and the
    // structured-object path (which serializes its JSON into `.text`).
    output: result.text,
    ...servedFromResponse(result.response),
  };
}

/**
 * Build the Langfuse span input from SDK call args. Prefers the chat
 * `messages` array (Langfuse renders it as a conversation); falls back to
 * the `prompt` string, folding in `system` when present. Attached to every
 * call's meta but only emitted when `LANGFUSE_CAPTURE_IO=true`.
 */
function captureInput(args: { system?: string; prompt?: unknown; messages?: unknown }): unknown {
  const { system, prompt, messages } = args;
  if (Array.isArray(messages)) {
    return system ? [{ role: "system", content: system }, ...messages] : messages;
  }
  if (prompt !== undefined) return system ? { system, prompt } : prompt;
  return system;
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

function usageFromSdk(usage: LanguageModelUsage | undefined) {
  if (!usage) return undefined;
  const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: cacheReadTokens,
  };
}

export type GenerateTextArgs = Parameters<typeof generateText>[0];
export type EmbedArgs = Parameters<typeof embed>[0];

type ObjectSchema<O> = Parameters<typeof Output.object<O>>[0]["schema"];

export interface MeteredGenerateObjectArgs<O> extends Omit<
  GenerateTextArgs,
  "output" | "experimental_output"
> {
  schema: ObjectSchema<O>;
  /** Optional name forwarded to `Output.object` — some providers use it for tool/schema naming. */
  schemaName?: string;
  /** Optional description forwarded to `Output.object` — surfaces as additional LLM guidance. */
  schemaDescription?: string;
}

export interface MeteredGenerateObjectResult<O> {
  object: O;
  usage: LanguageModelUsage;
  finishReason: FinishReason;
  warnings: CallWarning[] | undefined;
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
}

export async function meteredGenerateText(
  args: GenerateTextArgs,
  attribution: AttributedCall = {},
): Promise<GenerateTextResult<ToolSet, never>> {
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
  // never use `experimental_output`) can read freely.
  return metered(
    meta,
    () => generateText(callArgs),
    extractTextUsage as never,
  ) as unknown as Promise<GenerateTextResult<ToolSet, never>>;
}

/**
 * Structured-output wrapper. AI SDK v6 deprecated `generateObject` in favor of
 * `generateText` + `Output.object`, so we route through the text path and
 * project the schema-validated result into a `{ object, usage, ... }` shape
 * to keep call sites stable.
 */
export async function meteredGenerateObject<O>(
  args: MeteredGenerateObjectArgs<O>,
  attribution: AttributedCall = {},
): Promise<MeteredGenerateObjectResult<O>> {
  const { schema, schemaName, schemaDescription, ...rest } = args;
  const ids = resolveIds(rest.model, attribution);
  const meta: MeteredMeta = {
    ...attribution,
    kind: attribution.kind ?? "llm",
    ...ids,
    input: captureInput(rest as Parameters<typeof captureInput>[0]),
  };
  type Result = GenerateTextResult<ToolSet, ReturnType<typeof Output.object<O>>>;
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
  const result = (await metered(
    meta,
    () => generateText(callArgs),
    extractTextUsage as never,
  )) as unknown as Result;
  return {
    object: result.output,
    usage: result.totalUsage,
    finishReason: result.finishReason,
    warnings: result.warnings,
  };
}

export type StreamTextArgs = Parameters<typeof streamText>[0];
type StreamTextFinishEvent = Parameters<NonNullable<StreamTextArgs["onFinish"]>>[0];
type StreamTextErrorEvent = Parameters<NonNullable<StreamTextArgs["onError"]>>[0];
type StreamTextAbortEvent = Parameters<NonNullable<StreamTextArgs["onAbort"]>>[0];

/**
 * Streaming counterpart to `meteredGenerateText`. Returns the SDK's
 * `StreamTextResult` synchronously so the caller can consume `fullStream`
 * for live token / tool-call deltas; metering lands once the stream
 * finishes, via the SDK's `onFinish` / `onError` hooks. Produces exactly
 * one `api_call_log` row per streamed turn, same as the non-streaming path.
 *
 * Any caller-supplied `onFinish` / `onError` are preserved and invoked
 * after the metering hook runs.
 */
export function meteredStreamText(
  args: StreamTextArgs,
  attribution: AttributedCall = {},
): StreamTextResult<ToolSet, never> {
  const ids = resolveIds(args.model, attribution);
  const meta: MeteredMeta = {
    ...attribution,
    kind: attribution.kind ?? "llm",
    ...ids,
    input: captureInput(args as Parameters<typeof captureInput>[0]),
  };
  const callerOnFinish = args.onFinish;
  const callerOnError = args.onError;
  const callerOnAbort = args.onAbort;
  const timeout = args.timeout ?? DEFAULT_STREAM_TIMEOUT;
  return meteredStream(meta, ({ finish, fail, abort }) =>
    streamText({
      ...args,
      timeout,
      onFinish: (event: StreamTextFinishEvent) => {
        finish({
          usage: usageFromSdk(event.totalUsage),
          responseMeta: {
            finishReason: event.finishReason,
            toolCallCount: event.toolCalls?.length,
            stepCount: event.steps?.length,
          },
          output: event.text,
          ...servedFromResponse(event.response),
        });
        callerOnFinish?.(event);
      },
      onError: (event: StreamTextErrorEvent) => {
        fail(event.error instanceof Error ? event.error.message : String(event.error));
        callerOnError?.(event);
      },
      onAbort: (event: StreamTextAbortEvent) => {
        abort({
          usage: usageFromSteps(event.steps),
          responseMeta: {
            finishReason: "abort",
            stepCount: event.steps.length,
          },
        });
        callerOnAbort?.(event);
      },
    }),
  ) as StreamTextResult<ToolSet, never>;
}

function usageFromSteps(steps: readonly { usage?: LanguageModelUsage }[]) {
  if (steps.length === 0) return undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let sawUsage = false;
  for (const step of steps) {
    const usage = usageFromSdk(step.usage);
    if (!usage) continue;
    sawUsage = true;
    inputTokens += usage.inputTokens ?? 0;
    outputTokens += usage.outputTokens ?? 0;
    cachedInputTokens += usage.cachedInputTokens ?? 0;
  }
  if (!sawUsage) return undefined;
  return { inputTokens, outputTokens, cachedInputTokens };
}

export async function meteredEmbed(
  args: EmbedArgs,
  attribution: AttributedCall = {},
): Promise<EmbedResult> {
  const ids = resolveIds(args.model, attribution);
  const meta: MeteredMeta = { ...attribution, kind: "embedding", ...ids };
  // `embed` has no `timeout` param, only `abortSignal` — inject a timeout
  // signal so a hung embedding call can't wedge a worker step forever, same
  // backstop the text wrappers get via `timeout`.
  const callArgs: EmbedArgs =
    args.abortSignal !== undefined
      ? args
      : { ...args, abortSignal: AbortSignal.timeout(DEFAULT_LLM_TIMEOUT_MS) };
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
