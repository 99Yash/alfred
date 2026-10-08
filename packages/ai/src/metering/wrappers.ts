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
import { identifyLanguageModel, isModelObject, normalizeProvider } from "../models";
import { providerForServedModel } from "../provider-adapter";
import type { JsonObject } from "@alfred/contracts";
import {
  metered,
  meteredStream,
  type CallAttribution,
  type MeteredMeta,
  type MeteredResult,
  type MeteredStep,
} from "./metered";

// AI SDK calls wrapped in `metered()`. Provider and model come from the `LanguageModel`.

interface ModelIdentifiers {
  provider: string;
  model: string;
}

function modelIdsFor(model: LanguageModel): ModelIdentifiers {
  const { provider, modelId } = identifyLanguageModel(model);

  return { provider, model: modelId };
}

/**
 * Backstop when the caller sets no `timeout`. A hung socket would block a worker step forever,
 * and the heartbeat keeps stale-run recovery from reclaiming it.
 * Generous, because boss runs take minutes.
 */
const DEFAULT_LLM_TIMEOUT_MS = 600_000;

/** Backstop for direct {@link meteredStreamText} callers. A 30s chunk gap means a hung connection. */
const DEFAULT_STREAM_TIMEOUT = { chunkMs: 30_000, totalMs: DEFAULT_LLM_TIMEOUT_MS } as const;

// `result.usage` sums all steps but `result.response` names only the last, so each step
// is attributed to its own leg.
function extractTextUsage(
  result: GenerateTextResult<ToolSet, never, never>,
  cacheWriteTtl: AttributedCall["cacheWriteTtl"],
  model: LanguageModel,
): MeteredResult {
  const steps = extractStepAttribution(model, result.steps, cacheWriteTtl);

  return {
    usage: usageFromSdk(result.usage, cacheWriteTtl),
    responseMeta: {
      finishReason: result.finishReason,
      toolCallCount: result.toolCalls.length,
      stepCount: result.steps?.length,
      ...(steps ? { stepModels: steps.map((s) => `${s.provider}/${s.model}`) } : {}),
    },
    ...(steps ? { steps } : {}),

    output: captureOutput({ text: result.text, toolCalls: result.toolCalls }),
    ...servedFromModel(model, result.finalStep.response.modelId),
  };
}

/**
 * The generation output for the trace. A tool-call turn often has no text, and a staged or
 * rejected call never gets a tool span, so the proposed calls are kept here.
 * Without tool calls it returns the bare text.
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

/** Trace input: `messages` when present (Langfuse renders a conversation), else `prompt`. */
function captureInput(args: Pick<GenerateTextArgs, "instructions" | "prompt" | "messages">) {
  const { instructions, prompt, messages } = args;

  if (messages !== undefined) {
    if (typeof instructions === "string") {
      return [{ role: "system", content: instructions }, ...messages];
    }

    return instructions !== undefined ? [instructions, ...messages] : messages;
  }

  if (prompt !== undefined) return instructions ? { instructions, prompt } : prompt;

  return instructions;
}

/** The leg that answered, from the response model id. See `routeLegProviders` for the rule. */
function servedFromModel(
  model: LanguageModel,
  servedModelId: string | undefined,
): Pick<MeteredResult, "served" | "servedUnresolved"> {
  const nominal = identifyLanguageModel(model);

  if (servedModelId !== undefined && servedModelId !== nominal.modelId && isModelObject(model)) {
    const provider = providerForServedModel(model, servedModelId);

    if (provider !== undefined) return { served: { provider, model: servedModelId } };

    // No leg matches (for example an Anthropic dated snapshot). Keep the id so the row marks the miss.
    return { servedUnresolved: servedModelId };
  }

  if (nominal.provider === "unknown") return {};

  return { served: { provider: nominal.provider, model: nominal.modelId } };
}

/** The serving leg of each step, since each step can fall back on its own. `undefined` for one step. */
function extractStepAttribution(
  model: LanguageModel,
  steps: readonly {
    usage?: LanguageModelUsage | undefined;
    response?: { modelId?: string | undefined } | undefined;
    model?: { provider: string; modelId: string } | undefined;
  }[],
  cacheWriteTtl: AttributedCall["cacheWriteTtl"],
): readonly MeteredStep[] | undefined {
  if (steps.length <= 1) return undefined;
  const nominal = identifyLanguageModel(model);

  return steps.map((step) => {
    const responseModelId = step.response?.modelId;

    if (
      responseModelId !== undefined &&
      responseModelId !== nominal.modelId &&
      isModelObject(model)
    ) {
      const provider = providerForServedModel(model, responseModelId);

      if (provider !== undefined) {
        return {
          provider,
          model: responseModelId,
          usage: usageFromSdk(step.usage, cacheWriteTtl),
        };
      }
    }

    if (responseModelId !== undefined && responseModelId === nominal.modelId) {
      return {
        provider: nominal.provider,
        model: nominal.modelId,
        usage: usageFromSdk(step.usage, cacheWriteTtl),
      };
    }

    const stepModel = step.model;

    if (stepModel) {
      return {
        provider: normalizeProvider(stepModel.provider),
        model: stepModel.modelId,
        usage: usageFromSdk(step.usage, cacheWriteTtl),
      };
    }

    return {
      provider: nominal.provider,
      model: nominal.modelId,
      usage: usageFromSdk(step.usage, cacheWriteTtl),
    };
  });
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

type EmbedArgs = Parameters<typeof embed>[0];

type ObjectSchema<O> = Parameters<typeof Output.object<O>>[0]["schema"];

export interface MeteredGenerateObjectArgs<O> extends Omit<GenerateTextArgs, "output"> {
  schema: ObjectSchema<O>;
  schemaName?: string;
  schemaDescription?: string;
}

export interface AttributedCall extends CallAttribution {
  /** No full prompts. */
  requestMeta?: JsonObject | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  /** Langfuse name. Defaults to `${provider}/${model}`. */
  name?: string | undefined;
  idempotencyKey?: string | undefined;
  cacheWriteTtl?: "5m" | "1h" | undefined;
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
    input: captureInput(args),
  };

  const callArgs = withDefaultTimeout(args);

  // eslint-disable-next-line anti-slop/no-chained-type-assertions -- SDK Output interface not nameable (namespace alias only); pin public return to <ToolSet, never> for callers without structured output
  return metered(meta, () => generateText(callArgs), ((
    result: GenerateTextResult<ToolSet, never, never>,
  ) =>
    extractTextUsage(
      result,
      attribution.cacheWriteTtl,
      args.model,
    )) as never) as unknown as Promise<GenerateTextResult<ToolSet, never, never>>;
}

/** Structured output through `generateText` + `Output.object`. */
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
    input: captureInput(rest),
  };

  type Result = GenerateTextResult<ToolSet, never, ReturnType<typeof Output.object<O>>>;

  // eslint-disable-next-line anti-slop/no-chained-type-assertions -- discriminated Prompt union widens across Omit/spread; original args already satisfied the union
  const callArgs = {
    ...rest,
    timeout: rest.timeout ?? DEFAULT_LLM_TIMEOUT_MS,
    output: Output.object({
      schema,
      ...(schemaName !== undefined ? { name: schemaName } : {}),
      ...(schemaDescription !== undefined ? { description: schemaDescription } : {}),
    }),
  } as unknown as Parameters<typeof generateText>[0];

  // eslint-disable-next-line anti-slop/no-chained-type-assertions -- SDK Output interface not nameable (namespace alias only); pin public return to the structured-output Result
  return (await metered(meta, () => generateText(callArgs), ((
    result: GenerateTextResult<ToolSet, never, never>,
  ) =>
    extractTextUsage(
      result,
      attribution.cacheWriteTtl,
      rest.model,
    )) as never)) as unknown as Result;
}

export type StreamTextArgs = Parameters<typeof streamText>[0];

type StreamTextEndEvent = Parameters<NonNullable<StreamTextArgs["onEnd"]>>[0];

type StreamTextErrorEvent = Parameters<NonNullable<StreamTextArgs["onError"]>>[0];

type StreamTextAbortEvent = Parameters<NonNullable<StreamTextArgs["onAbort"]>>[0];

/** Streaming `meteredGenerateText`. Meters when the stream ends; caller hooks still run after. */
export function meteredStreamText(
  args: StreamTextArgs,
  attribution: AttributedCall = {},
): StreamTextResult<ToolSet, never, never> {
  const ids = resolveIds(args.model, attribution);

  const meta: MeteredMeta = {
    ...attribution,
    kind: attribution.kind ?? "llm",
    ...ids,
    input: captureInput(args),
  };

  const callerOnEnd = args.onEnd;
  const callerOnError = args.onError;
  const callerOnAbort = args.onAbort;
  const timeout = args.timeout ?? DEFAULT_STREAM_TIMEOUT;

  // SAFETY: meteredStream's signature erases streamText's generics; this restores them.
  return meteredStream(meta, ({ finish, fail, abort }) =>
    streamText({
      ...args,
      timeout,
      onEnd: (event: StreamTextEndEvent) => {
        const steps = extractStepAttribution(args.model, event.steps, attribution.cacheWriteTtl);
        finish({
          usage: usageFromSdk(event.usage, attribution.cacheWriteTtl),
          responseMeta: {
            finishReason: event.finishReason,
            toolCallCount: event.toolCalls.length,
            stepCount: event.steps?.length,
            ...(steps ? { stepModels: steps.map((s) => `${s.provider}/${s.model}`) } : {}),
          },
          ...(steps ? { steps } : {}),

          output: captureOutput({ text: event.text, toolCalls: event.toolCalls }),
          ...servedFromModel(args.model, event.finalStep.response.modelId),
        });
        callerOnEnd?.(event);
      },
      onError: (event: StreamTextErrorEvent) => {
        fail(event.error);
        callerOnError?.(event);
      },
      onAbort: (event: StreamTextAbortEvent) => {
        // Completed steps keep their own legs; only the unfinished rest uses the nominal leg.
        const served = servedFromModel(args.model, undefined);
        const steps = extractStepAttribution(args.model, event.steps, attribution.cacheWriteTtl);
        abort({
          usage: usageFromSteps(event.steps, attribution.cacheWriteTtl),
          responseMeta: {
            finishReason: "abort",
            stepCount: event.steps.length,
            ...(steps ? { stepModels: steps.map((s) => `${s.provider}/${s.model}`) } : {}),
          },
          ...(steps ? { steps } : {}),
          ...served,
        });
        callerOnAbort?.(event);
      },
    }),
  ) as StreamTextResult<ToolSet, never, never>;
}

/** Sum the usage of the steps that finished before an abort. */
export function usageFromSteps(
  steps: readonly { usage?: LanguageModelUsage }[],
  cacheWriteTtl?: "5m" | "1h",
) {
  if (steps.length === 0) return undefined;
  let inputTokens = 0;
  let noCacheInputTokens: number | undefined;
  let outputTokens = 0;
  // Stays undefined when no step reported it, not a false `0`.
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
  // `embed` has no `timeout`, so combine a timeout signal with the caller's signal.
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

function withDefaultTimeout(args: GenerateTextArgs): GenerateTextArgs {
  if (args.timeout !== undefined) return args;

  return { ...args, timeout: DEFAULT_LLM_TIMEOUT_MS };
}

function resolveIds(model: unknown, attribution: AttributedCall): ModelIdentifiers {
  if (attribution.provider && attribution.model) {
    return { provider: attribution.provider, model: attribution.model };
  }

  // SAFETY: callers pass the model of the request being metered; `unknown` only hides the SDK import.
  return modelIdsFor(model as LanguageModel);
}
