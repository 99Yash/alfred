import {
  stepCountIs,
  type CallWarning,
  type FinishReason,
  type GenerateTextResult,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type StreamTextResult,
  type SystemModelMessage,
  type Tool,
  type ToolSet,
  type TypedToolCall,
} from "ai";
import { meteredGenerateText, meteredStreamText, type AttributedCall } from "./metering/wrappers";

/**
 * Provider-options bag, structurally identical to the SDK's
 * `ProviderOptions` (`{ [provider]: { [key]: unknown } }`). We type it
 * inline rather than importing from `@ai-sdk/provider-utils` to avoid
 * pulling that into our direct deps for one type alias.
 */
type AlfredProviderOptions = Record<string, Record<string, unknown>>;

/**
 * AlfredAgent — a per-turn LLM driver designed to compose with the durable
 * runtime in `@alfred/api/agent`. See ADR-0026.
 *
 * Why not `ToolLoopAgent`:
 *   - ToolLoopAgent owns its own multi-step loop. We need a checkpoint
 *     between turns (ADR-0006/0014) so HIL interrupts and crash-resume work.
 *   - Per-turn metering (ADR-0015) wants one `api_call_log` row per LLM
 *     turn; ToolLoopAgent aggregates `totalUsage` across steps.
 *   - Lazy integration loading (dimension's pattern) needs the active
 *     toolset to be re-resolved per turn from run state, not per-call.
 *
 * Shape:
 *   - One `turn()` call = one model request = one metered row.
 *   - Tools come back from the resolver; AlfredAgent strips `execute` so
 *     the SDK never runs them. The executor is the dispatcher.
 *   - Tools are sorted alphabetically and the last definition gets a
 *     `cacheControl: ephemeral` breakpoint so the prompt-prefix bytes are
 *     identical across turns within a run and across runs that share the
 *     same integration set. Same goes for the system prompt.
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
   * set when run state changes (e.g. after a `load_integration` tool
   * call). Whatever order the resolver returns is fine — AlfredAgent
   * sorts alphabetically before the call. `execute` on returned tools is
   * stripped: the executor dispatches, not the SDK.
   */
  tools: (ctx: CTX) => Promise<ToolSet> | ToolSet;

  /** Underlying model. Resolver form lets capability-tagged dispatch swap providers per CTX. */
  model: LanguageModel | ((ctx: CTX) => Promise<LanguageModel> | LanguageModel);

  /**
   * Anthropic prompt-cache breakpoint TTL applied to the system block and
   * the last tool definition. Default `{ ttl: '1h' }`. `false` disables
   * the breakpoint entirely (use when bound to a non-Anthropic model that
   * ignores `cacheControl` or in tests). Other providers ignore the
   * namespaced metadata silently.
   */
  cacheControl?: { ttl: "5m" | "1h" } | false;

  maxOutputTokens?: number;
  temperature?: number;
  /** Forwarded verbatim to the SDK call — merged with cache annotations. */
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
   * it stalls past these bounds. Defaults to {@link DEFAULT_STREAM_TIMEOUT}.
   */
  streamTimeout?: { totalMs?: number; stepMs?: number; chunkMs?: number };
}

/**
 * Default streaming guard: a 30s gap between chunks means the stream is hung
 * (catches a wedged provider connection without killing a legitimately long
 * generation), with a 3-minute total ceiling as a hard backstop. Without this
 * a hung stream holds the workflow step open indefinitely.
 */
const DEFAULT_STREAM_TIMEOUT = { chunkMs: 30_000, totalMs: 180_000 } as const;

/**
 * Discriminated result of a single turn. The executor consumes `kind`:
 *   - `final`      → mark run done with `text`.
 *   - `tool-calls` → dispatch each tool, append results to transcript, schedule another turn.
 *   - `stopped`    → abnormal stop (length cap / content filter / error). Caller decides recovery.
 *
 * `raw.response.messages` is the canonical thing to append to the transcript.
 */
export type TurnResult =
  | {
      kind: "final";
      text: string;
      usage: LanguageModelUsage;
      finishReason: FinishReason;
      warnings: CallWarning[] | undefined;
      raw: GenerateTextResult<ToolSet, never>;
    }
  | {
      kind: "tool-calls";
      toolCalls: TypedToolCall<ToolSet>[];
      text: string;
      usage: LanguageModelUsage;
      finishReason: FinishReason;
      warnings: CallWarning[] | undefined;
      raw: GenerateTextResult<ToolSet, never>;
    }
  | {
      kind: "stopped";
      reason: "length" | "content-filter" | "error" | "other";
      usage: LanguageModelUsage;
      finishReason: FinishReason;
      warnings: CallWarning[] | undefined;
      raw: GenerateTextResult<ToolSet, never>;
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
    const { ctx, transcript } = args;

    const system = await resolve(this.s.system, ctx);
    this.assertStableSystem(system);

    const model = await resolve(this.s.model, ctx);
    const rawTools = await this.s.tools(ctx);
    const tools = decorateTools(rawTools, this.cacheTtl());

    const attribution = this.buildAttribution(args.attribution);

    const result = await meteredGenerateText(
      {
        model,
        system: buildSystem(system, this.cacheTtl()),
        messages: transcript,
        tools,
        // Cap at 1 step: the SDK should send the model request and return
        // — even if the model emits tool calls. Combined with `execute`-
        // less tools, the SDK never dispatches.
        stopWhen: stepCountIs(1),
        maxOutputTokens: this.s.maxOutputTokens,
        temperature: this.s.temperature,
        // The SDK types `providerOptions` as `JSONObject` per provider; our
        // public surface uses the looser `unknown` per provider so callers
        // don't have to import internal SDK types. Cast at the boundary.
        providerOptions: this.s.providerOptions as Record<string, never> | undefined,
        abortSignal: args.abortSignal,
      },
      attribution,
    );

    return classifyTurnResult(result);
  }

  /**
   * Streaming sibling of `turn()`. Same single-step semantics (the SDK sends
   * one model request and returns; `execute`-less tools mean it never
   * dispatches), same cache/strip/metering treatment — but returns the SDK's
   * `StreamTextResult` so the caller can consume `fullStream` for live token
   * and tool-call deltas as they arrive.
   *
   * The caller is responsible for draining `fullStream` to completion, then
   * awaiting `toolCalls` / `text` / `response` and passing them to
   * `classifyStreamFinish` to get the same discriminated outcome `turn()`
   * returns. Metering lands automatically when the stream finishes.
   */
  async streamTurn(args: TurnArgs<CTX>): Promise<StreamTextResult<ToolSet, never>> {
    const { ctx, transcript } = args;

    const system = await resolve(this.s.system, ctx);
    this.assertStableSystem(system);

    const model = await resolve(this.s.model, ctx);
    const rawTools = await this.s.tools(ctx);
    const tools = decorateTools(rawTools, this.cacheTtl());

    const attribution = this.buildAttribution(args.attribution);

    return meteredStreamText(
      {
        model,
        system: buildSystem(system, this.cacheTtl()),
        messages: transcript,
        tools,
        stopWhen: stepCountIs(1),
        maxOutputTokens: this.s.maxOutputTokens,
        temperature: this.s.temperature,
        providerOptions: this.s.providerOptions as Record<string, never> | undefined,
        abortSignal: args.abortSignal,
        timeout: args.streamTimeout ?? DEFAULT_STREAM_TIMEOUT,
      },
      attribution,
    );
  }

  // ── internals ──────────────────────────────────────────────────────────

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
      `Pin the system to (userId, activeIntegrations) only; never include run state, timestamps, or ids.`;
    if (this.s.strictSystem === false) {
      console.warn(msg);
      this.pinnedSystem = system;
      return;
    }
    throw new Error(msg);
  }

  private buildAttribution(perTurn: Partial<AttributedCall> | undefined): AttributedCall {
    const base = this.s.attribution ?? {};
    const merged: AttributedCall = { ...base, ...perTurn };
    if (!merged.name) {
      merged.name = this.id ? `agent:${this.id}` : merged.name;
    }
    return merged;
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

async function resolve<T, CTX>(v: T | ((ctx: CTX) => Promise<T> | T), ctx: CTX): Promise<T> {
  return typeof v === "function" ? await (v as (c: CTX) => Promise<T> | T)(ctx) : v;
}

/**
 * Drop `execute` from each tool, then sort alphabetically by name. Sort
 * order is load-bearing: insertion order maps to the wire serialization
 * order in `@ai-sdk/anthropic`, and the cache prefix is byte-sensitive.
 */
function decorateTools(tools: ToolSet, cacheTtl: "5m" | "1h" | undefined): ToolSet {
  const sortedNames = Object.keys(tools).sort((a, b) => a.localeCompare(b));
  const out: Record<string, Tool> = {};
  for (const name of sortedNames) {
    const def = tools[name];
    if (!def) continue;
    out[name] = stripExecute(def);
  }
  if (cacheTtl && sortedNames.length > 0) {
    const lastName = sortedNames[sortedNames.length - 1]!;
    const last = out[lastName]!;
    out[lastName] = withAnthropicCacheControl(last, cacheTtl);
  }
  return out as ToolSet;
}

function stripExecute(t: Tool): Tool {
  if (!("execute" in t) || t.execute === undefined) return t;
  // Drop `execute` while preserving the rest of the tool (schema,
  // providerOptions, etc.). A tool without `execute` is still a valid `Tool`
  // (it's optional), so the rest object needs no cast.
  const { execute: _execute, ...rest } = t;
  return rest;
}

function withAnthropicCacheControl(t: Tool, ttl: "5m" | "1h"): Tool {
  const existing = t.providerOptions ?? {};
  const existingAnthropic = (existing.anthropic ?? {}) as Record<string, unknown>;
  return {
    ...t,
    providerOptions: {
      ...existing,
      anthropic: {
        ...existingAnthropic,
        cacheControl: { type: "ephemeral", ttl },
      },
    },
  } as Tool;
}

function buildSystem(
  system: string,
  cacheTtl: "5m" | "1h" | undefined,
): string | SystemModelMessage {
  if (!cacheTtl) return system;
  return {
    role: "system",
    content: system,
    providerOptions: {
      anthropic: { cacheControl: { type: "ephemeral", ttl: cacheTtl } },
    },
  };
}

function classifyTurnResult(result: GenerateTextResult<ToolSet, never>): TurnResult {
  const base = {
    usage: result.usage,
    finishReason: result.finishReason,
    warnings: result.warnings,
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
 * Classify a finished streamed turn into the same discriminated shape
 * `turn()` returns. Call after draining `fullStream` and awaiting the
 * result's `toolCalls` + `finishReason`.
 */
export type StreamFinishOutcome =
  | { kind: "final" }
  | { kind: "tool-calls" }
  | { kind: "stopped"; reason: "length" | "content-filter" | "error" | "other" };

export function classifyStreamFinish(input: {
  toolCalls: TypedToolCall<ToolSet>[];
  finishReason: FinishReason;
}): StreamFinishOutcome {
  if (input.toolCalls.length > 0) return { kind: "tool-calls" };
  if (input.finishReason === "stop") return { kind: "final" };
  return { kind: "stopped", reason: nonStopReason(input.finishReason) };
}
