import {
  isStepCount,
  type CallWarning,
  type FinishReason,
  type GenerateTextResult,
  type LanguageModelUsage,
  type ModelMessage,
  type StreamTextResult,
  type ToolSet,
  type TypedToolCall,
} from "ai";
import type { SharedV4ProviderOptions } from "@ai-sdk/provider";
import { withDefaults } from "@alfred/contracts";
import { meteredGenerateText, meteredStreamText, type AttributedCall } from "./metering/wrappers";
import { attachProviderTurnPolicy, type ProviderAdaptedLanguageModel } from "./provider-adapter";

type AlfredProviderOptions = SharedV4ProviderOptions;

/**
 * AlfredAgent — a per-turn LLM driver designed to compose with the durable
 * runtime in `packages/assistant/src/execution/`. See ADR-0026.
 *
 * Why not `ToolLoopAgent`:
 *   - ToolLoopAgent owns its own multi-step loop. We need a checkpoint
 *     between turns (ADR-0006/0014) so HIL interrupts and crash-resume work.
 *   - Per-turn metering (ADR-0015) wants one `api_call_log` row per LLM
 *     turn; ToolLoopAgent aggregates `usage` across steps.
 *   - Lazy integration loading (dimension's pattern) needs the active
 *     toolset to be re-resolved per turn from run state, not per-call.
 *
 * Shape:
 *   - One `turn()` call = one model request = one metered row.
 *   - Tools come back from the resolver; AlfredAgent strips `execute` so
 *     the SDK never runs them. The executor is the dispatcher.
 *   - Tools are sorted alphabetically here. The concrete model's turn-protocol
 *     wrapper owns provider-specific cache decoration after fallback selection,
 *     so Anthropic gets stable breakpoints while Google gets no foreign metadata.
 *
 * Not implementing AI SDK's `Agent` interface (yet): the contract shape
 * (`generate()` returns aggregated `GenerateTextResult`) implies a
 * full in-process tool loop, which we deliberately don't have here. If
 * SDK interop is needed later (e.g. `createAgentUIStreamResponse`), wrap
 * this with a thin adapter rather than bending the per-turn semantics.
 */

export type Transcript = ModelMessage[];

/** Constructor settings — bind to a single agent identity (boss, sub-agent kind, compactor). */
export interface AlfredAgentSettings<CTX = unknown> {
  /** Stable identifier; surfaced as `agent:<id>` to Langfuse when no `name` override is given. */
  id?: string;

  /**
   * System prompt. Resolved once on the first turn and pinned — must be
   * stable per CTX for prompt caching to land. See `strictSystem`.
   */
  system: string | ((ctx: CTX) => Promise<string> | string);

  /**
   * Active tools for this turn. Called per-turn so callers can swap the
   * set when run state changes (e.g. after an exact `load_tool` call
   * call). Whatever order the resolver returns is fine — AlfredAgent
   * sorts alphabetically before the call. `execute` on returned tools is
   * stripped: the executor dispatches, not the SDK.
   */
  tools: (ctx: CTX) => Promise<ToolSet> | ToolSet;

  /**
   * Provider-adapted model from an @alfred/ai model factory. Resolver form lets
   * capability-tagged dispatch swap providers per CTX without admitting a raw
   * SDK model that cannot consume Alfred's internal turn-policy envelope.
   */
  model:
    | ProviderAdaptedLanguageModel
    | ((ctx: CTX) => Promise<ProviderAdaptedLanguageModel> | ProviderAdaptedLanguageModel);

  /**
   * Prompt-cache policy consumed by the concrete model's protocol wrapper.
   * Anthropic applies it to the system, last function tool, and growing
   * transcript. Other providers remove the internal policy envelope without
   * receiving Anthropic metadata. Default `{ ttl: '1h' }`; `false` disables it.
   */
  cacheControl?: { ttl: "5m" | "1h" } | false;

  maxOutputTokens?: number;
  temperature?: number;
  /** Forwarded to the concrete protocol wrapper, then to the matching SDK adapter. */
  providerOptions?: AlfredProviderOptions;

  /**
   * Default attribution merged with per-turn `attribution`. Per-turn wins
   * on overlap. Useful for binding `userId`/`runId`/`name` once.
   */
  attribution?: Partial<AttributedCall>;

  /**
   * `true` (default): throw if the resolved system prompt changes between
   * turns — cache misses caused by drifting system blocks are silent and
   * expensive. `false`: warn and continue.
   */
  strictSystem?: boolean;
}

export interface TurnArgs<CTX> {
  ctx: CTX;
  transcript: Transcript;
  /** Per-turn attribution overrides. `runId`/`stepId`/`attempt` typically come from the executor. */
  attribution?: Partial<AttributedCall>;
  abortSignal?: AbortSignal;
  /**
   * Streaming circuit-breaker (`streamTurn` only). The SDK aborts the call if
   * it stalls past these bounds. Defaults to {@link DEFAULT_TURN_STREAM_TIMEOUT}.
   */
  streamTimeout?: { totalMs?: number; stepMs?: number; chunkMs?: number };
}

/**
 * Default streaming guard: a 30s gap between chunks means the stream is hung
 * (catches a wedged provider connection without killing a legitimately long
 * generation), with a 3-minute total ceiling as a hard backstop. Without this
 * a hung stream holds the workflow step open indefinitely.
 */
export const DEFAULT_TURN_STREAM_TIMEOUT = { chunkMs: 30_000, totalMs: 180_000 } as const;

/**
 * Discriminated result of a single turn. The executor consumes `kind`:
 *   - `final`      → mark run done with `text`.
 *   - `tool-calls` → dispatch each tool, append results to transcript, schedule another turn.
 *   - `empty`      → a retryable empty completion (see {@link isRetryableEmptyCompletion}):
 *                    no text, no tool calls, a clean/errored finish. The caller should
 *                    regenerate the turn from the *unchanged* transcript a bounded number
 *                    of times before giving up — never append the empty assistant message.
 *   - `stopped`    → abnormal stop (length cap / content filter). Caller decides recovery.
 *
 * `raw.responseMessages` is the canonical thing to append to the transcript.
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
  /** Cached resolved system prompt — captured on first turn for drift detection. */
  private pinnedSystem: string | undefined;

  constructor(private readonly s: AlfredAgentSettings<CTX>) {
    this.id = s.id;
  }

  async turn(args: TurnArgs<CTX>): Promise<TurnResult> {
    const { request, attribution } = await this.prepareTurn(args);
    const result = await meteredGenerateText(request, attribution);
    return classifyTurnResult(result);
  }

  /**
   * Streaming sibling of `turn()`. Same single-step semantics (the SDK sends
   * one model request and returns; `execute`-less tools mean it never
   * dispatches), same cache/strip/metering treatment — but returns the SDK's
   * `StreamTextResult` so the caller can consume `stream` for live token
   * and tool-call deltas as they arrive.
   *
   * The caller is responsible for draining `stream` to completion, then
   * awaiting `toolCalls` / `text` / `response` and passing them to
   * `classifyStreamFinish` to get the same discriminated outcome `turn()`
   * returns. Metering lands automatically when the stream finishes.
   */
  async streamTurn(args: TurnArgs<CTX>): Promise<StreamTextResult<ToolSet, never, never>> {
    const { request, attribution } = await this.prepareTurn(args);
    return meteredStreamText(
      { ...request, timeout: args.streamTimeout ?? DEFAULT_TURN_STREAM_TIMEOUT },
      attribution,
    );
  }

  // ── internals ──────────────────────────────────────────────────────────

  /**
   * Shared per-turn setup for `turn()` and `streamTurn()`: resolve the system
   * prompt (asserting it stays stable across a run), model, and tools, then
   * assemble the request payload both paths send. `streamTurn` layers its
   * stream `timeout` on top; everything else is identical single-step
   * (`execute`-less tools, `stopWhen: isStepCount(1)`) semantics.
   */
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
      // Compaction prepends a server-authored `<run_summary>` system message
      // to the persisted transcript. AI SDK 7 rejects system messages in
      // `messages` by default; this opt-in is safe because transcript roles
      // are assigned by Alfred, never accepted from user input.
      allowSystemInMessages: true,
      tools,
      // Cap at 1 step: the SDK should send the model request and return
      // — even if the model emits tool calls. Combined with `execute`-
      // less tools, the SDK never dispatches.
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
    // Three layers of precedence: per-turn beats agent-level beats the resolved
    // TTL. `withDefaults` rather than a spread at each layer because EVERY
    // `AttributedCall` field is declared `| undefined`, so a present-undefined
    // override wins a spread and clobbers the layer beneath it with nothing —
    // an agent-level `cacheWriteTtl` silently lost to a per-turn `{ ttl: undefined }`
    // is TTL-aware billing reading the wrong rate.
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

// ── helpers ────────────────────────────────────────────────────────────────

async function resolve<T, CTX>(v: T | ((ctx: CTX) => Promise<T> | T), ctx: CTX): Promise<T> {
  // SAFETY: the typeof check above proved v is the callable arm of the union;
  // the assertion restores exactly that arm's signature.
  return typeof v === "function" ? await (v as (c: CTX) => Promise<T> | T)(ctx) : v;
}

/**
 * Drop `execute` from each tool, then sort alphabetically by name. Sort
 * order is load-bearing: insertion order maps to the wire serialization
 * order in `@ai-sdk/anthropic`, and the cache prefix is byte-sensitive.
 */
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

/**
 * These helpers speak `ToolSet[string]`, not the SDK's bare `Tool`: the two stop
 * being mutually assignable under `exactOptionalPropertyTypes` (bare `Tool`
 * pins its INPUT generic to `never`), and `ToolSet[string]` is the one a
 * `ToolSet` actually holds — so threading it through needs no cast.
 */
type ToolSetEntry = ToolSet[string];

function stripExecute(t: ToolSetEntry): ToolSetEntry {
  if (!("execute" in t) || t.execute === undefined) return t;
  // Drop `execute` while preserving the rest of the tool (schema,
  // providerOptions, etc.). A tool without `execute` is still a valid tool
  // (it's optional), so the rest object needs no cast.
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
 * True when a finished turn came back with **no assistant text and no tool
 * calls** — an empty completion — on a finish reason a bounded retry can plausibly
 * clear.
 *
 * Included (retryable): a clean `stop`, a provider `error`, or an `unknown`/`other`
 * finish with zero output. This is the transient provider anomaly the
 * Anthropic→Gemini quota fallback surfaces — when Anthropic hits its workspace
 * spend cap, `withFallback` degrades to Gemini 3.5 Flash, which may return
 * a `finishReason:stop` candidate with 0 output tokens (see the 2026-07-10 chat-turn
 * dig, trace `run_hesh6eyb1m01`). `withFallback` itself cannot catch this: the SDK
 * call *succeeds* with an empty stream, so there is no error for the retry cascade
 * to switch on — degrading is the executor's job. Re-attempting the same turn
 * usually produces real output.
 *
 * Excluded (surface, don't retry): `content-filter` (a safety block) and `length`
 * (the output budget was exhausted, often by thinking) do not self-heal on an
 * identical re-attempt.
 */
export function isRetryableEmptyCompletion(input: {
  finishReason: FinishReason;
  hasToolCalls: boolean;
  textLength: number;
}): boolean {
  if (input.hasToolCalls || input.textLength > 0) return false;
  return input.finishReason !== "content-filter" && input.finishReason !== "length";
}

/**
 * Classify a finished streamed turn into the same discriminated shape
 * `turn()` returns. Call after draining `stream` and awaiting the
 * result's `toolCalls` + `finishReason`.
 */
export type StreamFinishOutcome =
  | { kind: "final" }
  | { kind: "tool-calls" }
  | { kind: "empty" }
  | { kind: "stopped"; reason: "length" | "content-filter" | "error" | "other" };

export function classifyStreamFinish(input: {
  /** Only presence matters here; callers need not manufacture a full SDK call shape. */
  toolCalls: readonly unknown[];
  finishReason: FinishReason;
  /**
   * Trimmed length of the assistant text streamed this turn. The streaming
   * executor accumulates the text itself (`state.assistantText`), so it passes
   * the length in rather than us re-deriving it from a result object. Lets this
   * detect the `empty` outcome symmetrically with {@link classifyTurnResult}.
   */
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
