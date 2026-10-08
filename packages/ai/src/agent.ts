import {
  isStepCount,
  type CallWarning,
  type FinishReason,
  type GenerateTextResult,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type StreamTextResult,
  type ToolSet,
  type TypedToolCall,
} from "ai";
import type { SharedV4ProviderOptions } from "@ai-sdk/provider";
import { withDefaults } from "@alfred/contracts";
import { meteredGenerateText, meteredStreamText, type AttributedCall } from "./metering/wrappers";
import { attachProviderTurnPolicy } from "./provider-adapter";

type AlfredProviderOptions = SharedV4ProviderOptions;

/**
 * One model request per `turn()`, one metered row per turn (ADR-0026).
 * Not `ToolLoopAgent`: the durable runtime checkpoints between turns (ADR-0006/0014)
 * and resolves the toolset per turn. Tools lose `execute`, so the executor dispatches them.
 */

export type Transcript = ModelMessage[];

export interface AlfredAgentSettings<CTX = unknown> {
  /** Langfuse name `agent:<id>` when no `name` is given. */
  id?: string;

  /** Pinned on the first turn. It must not change, or the prompt cache misses. */
  system: string | ((ctx: CTX) => Promise<string> | string);

  /** Called every turn, so the set can change with run state. */
  tools: (ctx: CTX) => Promise<ToolSet> | ToolSet;

  /** Must come from an @alfred/ai route or leg, which applies the provider's cache markers. */
  model: LanguageModel | ((ctx: CTX) => Promise<LanguageModel> | LanguageModel);

  /**
   * Anthropic marks the system, last tool, and transcript. Other providers ignore it.
   * Default `{ ttl: '1h' }`; `false` turns it off.
   */
  cacheControl?: { ttl: "5m" | "1h" } | false;

  maxOutputTokens?: number;
  temperature?: number;
  providerOptions?: AlfredProviderOptions;

  /** Per-turn `attribution` wins on overlap. */
  attribution?: Partial<AttributedCall>;

  /** Default `true`: throw when the system prompt changes. `false` warns instead. */
  strictSystem?: boolean;
}

export interface TurnArgs<CTX> {
  ctx: CTX;
  transcript: Transcript;
  attribution?: Partial<AttributedCall>;
  abortSignal?: AbortSignal;
  /** `streamTurn` only. Defaults to {@link DEFAULT_TURN_STREAM_TIMEOUT}. */
  streamTimeout?: { totalMs?: number; stepMs?: number; chunkMs?: number };
}

/** A 30s gap between chunks means a hung stream. Without this, it holds the step open forever. */
export const DEFAULT_TURN_STREAM_TIMEOUT = { chunkMs: 30_000, totalMs: 180_000 } as const;

/**
 * The outcome of one turn. On `empty`, regenerate from the unchanged transcript a few times;
 * never append the empty message. Append `raw.responseMessages` to the transcript.
 */
export type TurnResult =
  | {
      kind: "final";
      text: string;
      usage: LanguageModelUsage;
      finishReason: FinishReason;
      warnings: CallWarning[] | undefined;
      raw: GenerateTextResult<ToolSet, never, never>;
    }
  | {
      kind: "tool-calls";
      toolCalls: TypedToolCall<ToolSet>[];
      text: string;
      usage: LanguageModelUsage;
      finishReason: FinishReason;
      warnings: CallWarning[] | undefined;
      raw: GenerateTextResult<ToolSet, never, never>;
    }
  | {
      kind: "empty";
      usage: LanguageModelUsage;
      finishReason: FinishReason;
      warnings: CallWarning[] | undefined;
      raw: GenerateTextResult<ToolSet, never, never>;
    }
  | {
      kind: "stopped";
      reason: "length" | "content-filter" | "error" | "other";
      usage: LanguageModelUsage;
      finishReason: FinishReason;
      warnings: CallWarning[] | undefined;
      raw: GenerateTextResult<ToolSet, never, never>;
    };

const DEFAULT_CACHE_TTL: "5m" | "1h" = "1h";

export class AlfredAgent<CTX = unknown> {
  readonly id: string | undefined;
  private pinnedSystem: string | undefined;

  constructor(private readonly s: AlfredAgentSettings<CTX>) {
    this.id = s.id;
  }

  async turn(args: TurnArgs<CTX>): Promise<TurnResult> {
    const { request, attribution } = await this.prepareTurn(args);
    const result = await meteredGenerateText(request, attribution);

    return classifyTurnResult(result);
  }

  /** `turn()` as a stream. Drain it, then pass the result to `classifyStreamFinish`. */
  async streamTurn(args: TurnArgs<CTX>): Promise<StreamTextResult<ToolSet, never, never>> {
    const { request, attribution } = await this.prepareTurn(args);

    return meteredStreamText(
      { ...request, timeout: args.streamTimeout ?? DEFAULT_TURN_STREAM_TIMEOUT },
      attribution,
    );
  }

  private async prepareTurn(args: TurnArgs<CTX>) {
    const { ctx, transcript } = args;

    const system = await resolve(this.s.system, ctx);
    this.assertStableSystem(system);

    const model = await resolve(this.s.model, ctx);
    const rawTools = await this.s.tools(ctx);
    const tools = prepareTools(rawTools);

    const attribution = this.buildAttribution(args.attribution, this.cacheTtl());

    const request = {
      model,
      instructions: system,
      messages: transcript,
      // Compaction adds a `<run_summary>` system message. Safe: Alfred assigns every role.
      allowSystemInMessages: true,
      tools,
      // One step, so the SDK returns tool calls instead of running them.
      stopWhen: isStepCount(1),
      ...(this.s.maxOutputTokens !== undefined ? { maxOutputTokens: this.s.maxOutputTokens } : {}),
      ...(this.s.temperature !== undefined ? { temperature: this.s.temperature } : {}),
      providerOptions: attachProviderTurnPolicy(this.s.providerOptions, this.cacheTtl()),
      ...(args.abortSignal !== undefined ? { abortSignal: args.abortSignal } : {}),
    };

    return { request, attribution };
  }

  private cacheTtl(): "5m" | "1h" | undefined {
    if (this.s.cacheControl === false) return undefined;

    return this.s.cacheControl?.ttl ?? DEFAULT_CACHE_TTL;
  }

  private assertStableSystem(system: string): void {
    if (this.pinnedSystem === undefined) {
      this.pinnedSystem = system;

      return;
    }

    if (this.pinnedSystem === system) return;
    const tag = this.id ? ` ${this.id}` : "";

    const msg =
      `[AlfredAgent${tag}] system prompt changed between turns — kills the prompt cache. ` +
      `original_len=${this.pinnedSystem.length} new_len=${system.length}. ` +
      `Pin the system to stable user/tool-surface context only; never include run state, timestamps, or ids.`;

    if (this.s.strictSystem === false) {
      console.warn(msg);
      this.pinnedSystem = system;

      return;
    }

    throw new Error(msg);
  }

  private buildAttribution(
    perTurn: Partial<AttributedCall> | undefined,
    cacheWriteTtl: "5m" | "1h" | undefined,
  ): AttributedCall {
    // Per-turn beats agent-level beats the TTL. `withDefaults`, not a spread:
    // a spread lets a present `undefined` erase the layer below.
    const merged: AttributedCall = withDefaults(
      withDefaults<AttributedCall>({ cacheWriteTtl }, this.s.attribution),
      perTurn,
    );

    if (!merged.name && this.id) {
      merged.name = `agent:${this.id}`;
    }

    return merged;
  }
}

async function resolve<T, CTX>(v: T | ((ctx: CTX) => Promise<T> | T), ctx: CTX): Promise<T> {
  // SAFETY: the typeof check proves v is the function arm of the union.
  return typeof v === "function" ? await (v as (c: CTX) => Promise<T> | T)(ctx) : v;
}

/** Drop `execute` and sort by name. The order reaches the wire, and the cache prefix is byte-exact. */
function prepareTools(tools: ToolSet): ToolSet {
  const sortedNames = Object.keys(tools).sort((a, b) => a.localeCompare(b));
  const out: ToolSet = {};

  for (const name of sortedNames) {
    const def = tools[name];

    if (!def) continue;
    out[name] = stripExecute(def);
  }

  return out;
}

/** Not the bare `Tool`, which pins its input to `never` and stops being assignable. */
type ToolSetEntry = ToolSet[string];

function stripExecute(t: ToolSetEntry): ToolSetEntry {
  if (!("execute" in t) || t.execute === undefined) return t;
  const { execute: _execute, ...rest } = t;

  return rest;
}

function classifyTurnResult(result: GenerateTextResult<ToolSet, never, never>): TurnResult {
  const base = {
    usage: result.usage,
    finishReason: result.finishReason,
    warnings: result.finalStep.warnings,
    raw: result,
  } as const;

  if (result.toolCalls.length > 0) {
    return {
      kind: "tool-calls",
      toolCalls: result.toolCalls,
      text: result.text,
      ...base,
    };
  }

  if (
    isRetryableEmptyCompletion({
      finishReason: result.finishReason,
      hasToolCalls: false,
      textLength: result.text.trim().length,
    })
  ) {
    return { kind: "empty", ...base };
  }

  if (result.finishReason === "stop") {
    return { kind: "final", text: result.text, ...base };
  }

  return { kind: "stopped", reason: nonStopReason(result.finishReason), ...base };
}

function nonStopReason(r: FinishReason): "length" | "content-filter" | "error" | "other" {
  if (r === "length" || r === "content-filter" || r === "error") return r;

  return "other";
}

/**
 * No text and no tool calls, on a finish a retry can clear. Some models return an empty `stop`;
 * the call succeeds, so `withFallback` never sees it.
 * `content-filter` and `length` are not retryable: the same request fails the same way.
 */
export function isRetryableEmptyCompletion(input: {
  finishReason: FinishReason;
  hasToolCalls: boolean;
  textLength: number;
}): boolean {
  if (input.hasToolCalls || input.textLength > 0) return false;

  return input.finishReason !== "content-filter" && input.finishReason !== "length";
}

/** `turn()`'s outcome for a stream. */
export type StreamFinishOutcome =
  | { kind: "final" }
  | { kind: "tool-calls" }
  | { kind: "empty" }
  | { kind: "stopped"; reason: "length" | "content-filter" | "error" | "other" };

export function classifyStreamFinish(input: {
  /** Only the count matters. */
  toolCalls: readonly unknown[];
  finishReason: FinishReason;
  /** Trimmed length of the streamed assistant text. */
  textLength: number;
}): StreamFinishOutcome {
  if (input.toolCalls.length > 0) return { kind: "tool-calls" };

  if (
    isRetryableEmptyCompletion({
      finishReason: input.finishReason,
      hasToolCalls: false,
      textLength: input.textLength,
    })
  ) {
    return { kind: "empty" };
  }

  if (input.finishReason === "stop") return { kind: "final" };

  return { kind: "stopped", reason: nonStopReason(input.finishReason) };
}
