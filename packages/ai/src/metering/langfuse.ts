import { serverEnv } from "@alfred/env/server";
import { createHash, randomUUID } from "node:crypto";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  propagateAttributes,
  setLangfuseTracerProvider,
  startObservation,
  type LangfuseGeneration,
  type LangfuseSpan,
  type PropagateAttributesParams,
} from "@langfuse/tracing";
import { ROOT_CONTEXT, TraceFlags, context, type SpanContext } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import type { CallKind, CallUsage, MeteredMeta } from "./metered";
import {
  APPROVAL_EXPIRY_MS,
  sanitizeErrorMessage,
  summarizeBody,
  toMessage,
  toStringArray,
} from "@alfred/contracts";
import type { JsonObject } from "@alfred/contracts";

/**
 * Langfuse tracing, built once per process (ADR-0023). Without keys, tracing is a no-op;
 * the `api_call_log` row still lands.
 * Uses Langfuse's own tracer provider, so it never replaces the one `Sentry.init` installs.
 * Every observation opener must go through `startRunAttributedObservation`,
 * or its span loses the run's session, user, and tags.
 */
type LangfuseRuntime = { readonly provider: BasicTracerProvider };

let _runtime: LangfuseRuntime | "noop" | undefined;

function getRuntime(): LangfuseRuntime | null {
  if (_runtime === "noop") return null;

  if (_runtime) return _runtime;

  const env = serverEnv();

  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) {
    _runtime = "noop";

    return null;
  }

  try {
    const processor = new LangfuseSpanProcessor({
      publicKey: env.LANGFUSE_PUBLIC_KEY,
      secretKey: env.LANGFUSE_SECRET_KEY,
      ...(env.LANGFUSE_HOST ? { baseUrl: env.LANGFUSE_HOST } : {}),
      // Every deploy target runs `NODE_ENV=production`, so prefer the per-target slug.
      environment: env.LANGFUSE_TRACING_ENVIRONMENT ?? env.NODE_ENV,
      ...(env.LANGFUSE_RELEASE ? { release: env.LANGFUSE_RELEASE } : {}),
    });

    const provider = new BasicTracerProvider({ spanProcessors: [processor] });

    // `propagateAttributes` needs a context manager. Scripts run without Sentry's,
    // so register one. No-op when one already exists.
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

    setLangfuseTracerProvider(provider);
    _runtime = { provider };

    return _runtime;
  } catch (err) {
    console.warn("[langfuse] init failed:", toMessage(err));
    _runtime = "noop";

    return null;
  }
}

/** Test-only: use the given provider. Returns a restore function. */
export function _setLangfuseRuntimeForTests(provider: BasicTracerProvider): () => void {
  const previous = _runtime;
  _runtime = { provider };
  setLangfuseTracerProvider(provider);

  return () => {
    _runtime = previous;
    setLangfuseTracerProvider(previous && previous !== "noop" ? previous.provider : null);
  };
}

/**
 * Hash a logical trace id (`runId` or `adhoc:<key>`) to a 32-hex OTel trace id.
 * Same hash as `w3cTraceId` in the MCP trace module, so MCP peers see this trace id.
 */
export function langfuseTraceId(logicalTraceId: string): string {
  const derived = createHash("sha256").update(logicalTraceId).digest("hex").slice(0, 32);

  return /^0+$/.test(derived) ? "00000000000000000000000000000001" : derived;
}

function traceSpanContext(logicalTraceId: string): SpanContext {
  const digest = createHash("sha256").update(logicalTraceId).digest("hex");

  return {
    traceId: langfuseTraceId(logicalTraceId),
    // A fake parent. It exists only so children inherit the trace id.
    spanId: digest.slice(32, 48),
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  };
}

/** Trace-level attributes, set on each observation. The root observation's I/O is the trace's. */
function traceAttributeParams(payload: {
  name: string;
  userId?: string | undefined;
  sessionId?: string | undefined;
  tags?: string[] | undefined;
}): PropagateAttributesParams {
  return {
    traceName: payload.name,
    ...(payload.userId !== undefined ? { userId: payload.userId } : {}),
    ...(payload.sessionId !== undefined ? { sessionId: payload.sessionId } : {}),
    ...(payload.tags !== undefined ? { tags: payload.tags } : {}),
  };
}

/**
 * Apply trace attributes to the observation `fn` creates.
 * `propagateAttributes` also stamps the active span, which is usually Sentry's.
 * `ROOT_CONTEXT` hides that span, so user and session ids do not leak onto Sentry.
 */
function withTraceAttributes<T>(params: PropagateAttributesParams, fn: () => T): T {
  return context.with(ROOT_CONTEXT, () => propagateAttributes(params, fn));
}

type RunTraceIdentity = {
  name: string;
  userId?: string | undefined;
  sessionId?: string | undefined;
  tags?: string[] | undefined;
};

/**
 * Each run's identity, keyed by `runId`, so tool and runtime spans opened after the
 * generation returns can carry it.
 * Process-local: a run resumed on another instance finds no entry and its spans open bare.
 * The latest call wins; a later call with fewer fields narrows the entry.
 */
const runIdentities = new Map<string, { at: number; identity: RunTraceIdentity }>();

/**
 * A staged tool call opens its span on resume with no new generation, so the identity
 * must outlive the longest approval wait (ADR-0034).
 */
const RUN_IDENTITY_TTL_MS = APPROVAL_EXPIRY_MS;

const RUN_IDENTITY_SWEEP_MS = 60 * 60_000;

let lastRunIdentitySweepMs = 0;

function rememberRunIdentity(runId: string, identity: RunTraceIdentity): void {
  const now = Date.now();

  if (now - lastRunIdentitySweepMs >= RUN_IDENTITY_SWEEP_MS) {
    for (const [key, entry] of runIdentities) {
      if (now - entry.at >= RUN_IDENTITY_TTL_MS) runIdentities.delete(key);
    }

    lastRunIdentitySweepMs = now;
  }

  runIdentities.set(runId, { at: now, identity });
}

/** Open an observation with its run's trace attributes, or bare when the run has none yet. */
function startRunAttributedObservation<T>(runId: string, create: () => T): T {
  const entry = runIdentities.get(runId);

  return entry ? withTraceAttributes(traceAttributeParams(entry.identity), create) : create();
}

export interface LangfuseSpanInput {
  meta: MeteredMeta;
  startedAt: Date;
}

/** Closes a generation span. SDK errors are swallowed so tracing never breaks the call. */
export interface LangfuseSpanCloser {
  success(args: {
    usage?: CallUsage | undefined;
    costUsd: number;
    /** Attached only when I/O capture is on. */
    output?: unknown;
    /** Always attached. */
    responseMeta?: JsonObject | undefined;
    /** The model that actually ran, when a fallback switched it. */
    servedModel?: string | undefined;
  }): void;
  error(message: string): void;
}

/** Attach prompt and completion text only when enabled. It can hold PII. */
function shouldCaptureIo(): boolean {
  return serverEnv().LANGFUSE_CAPTURE_IO === true;
}

export function startLangfuseSpan(input: LangfuseSpanInput): LangfuseSpanCloser {
  const runtime = getRuntime();

  if (!runtime) {
    return {
      success() {
        /* no-op when keys missing */
      },
      error() {
        /* no-op */
      },
    };
  }

  const { meta, startedAt } = input;
  const captureIo = shouldCaptureIo();
  const tracePayload = buildTracePayload(meta);
  const generationPayload = buildGenerationPayload({ meta, startedAt, captureIo });
  let generation: LangfuseGeneration | null = null;

  try {
    // Langfuse unions tags across a trace, so a multi-role run collects every role tag.
    generation = withTraceAttributes(traceAttributeParams(tracePayload), () =>
      startObservation(
        generationPayload.name,
        {
          model: generationPayload.model,
          ...(generationPayload.modelParameters !== undefined
            ? { modelParameters: generationPayload.modelParameters }
            : {}),
          ...(generationPayload.input !== undefined ? { input: generationPayload.input } : {}),
          metadata: generationPayload.metadata,
        },
        {
          asType: "generation",
          startTime: generationPayload.startTime,
          parentSpanContext: traceSpanContext(tracePayload.id),
        },
      ),
    );
  } catch (err) {
    console.warn("[langfuse] span start failed:", toMessage(err));
  }

  // Ad-hoc calls have no run and no later spans, so they take no entry.
  if (meta.runId) {
    rememberRunIdentity(meta.runId, tracePayload);
  }

  return {
    success({ usage, costUsd, output, responseMeta, servedModel }) {
      try {
        const end = buildGenerationEndPayload({
          meta,
          usage,
          costUsd,
          output,
          responseMeta,
          servedModel,
          captureIo,
        });

        generation?.update({
          ...(end.model !== undefined ? { model: end.model } : {}),
          ...(end.usageDetails !== undefined ? { usageDetails: end.usageDetails } : {}),
          costDetails: end.costDetails,
          ...(end.output !== undefined ? { output: end.output } : {}),
          ...(end.metadata !== undefined ? { metadata: end.metadata } : {}),
        });
        generation?.end();
      } catch (err) {
        console.warn("[langfuse] span end failed:", toMessage(err));
      }
    },
    error(message) {
      try {
        generation?.update({ level: "ERROR", statusMessage: message });
        generation?.end();
      } catch (err) {
        console.warn("[langfuse] span error end failed:", toMessage(err));
      }
    },
  };
}

export interface ToolSpanInput {
  /** Also the trace id. */
  runId: string;
  toolName: string;
  toolCallId: string;
  userId?: string;
  /** `boss` or a sub-agent name. */
  caller?: string;
  stepId?: string;
  /** Attached only when I/O capture is on. */
  input?: unknown;
  startedAt: Date;
}

export interface ToolSpanCloser {
  /** `output` needs I/O capture. `metadata` is always recorded, so it must hold no PII. */
  success(output?: unknown, metadata?: JsonObject): void;
  error(message: string): void;
}

/** Open a span for one tool execution under the run trace. SDK errors are swallowed. */
export function startToolSpan(args: ToolSpanInput): ToolSpanCloser {
  const runtime = getRuntime();

  if (!runtime) {
    return {
      success() {
        /* no-op when keys missing */
      },
      error() {
        /* no-op */
      },
    };
  }

  const captureIo = shouldCaptureIo();
  let span: LangfuseSpan | null = null;

  try {
    span = startRunAttributedObservation(args.runId, () =>
      startObservation(
        `tool:${args.toolName}`,
        {
          ...(captureIo && args.input !== undefined ? { input: args.input } : {}),
          metadata: {
            kind: "tool",
            toolName: args.toolName,
            toolCallId: args.toolCallId,
            caller: args.caller,
            userId: args.userId,
            runId: args.runId,
            stepId: args.stepId,
          },
        },
        {
          asType: "span",
          startTime: args.startedAt,
          parentSpanContext: traceSpanContext(args.runId),
        },
      ),
    );
  } catch (err) {
    console.warn("[langfuse] tool span start failed:", toMessage(err));
  }

  return {
    success(output, metadata) {
      try {
        // `update` merges metadata, so the opening `kind: "tool"` block stays.
        span?.update({
          ...(captureIo && output !== undefined ? { output } : {}),
          ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
        });
        span?.end();
      } catch (err) {
        console.warn("[langfuse] tool span end failed:", toMessage(err));
      }
    },
    error(message) {
      try {
        // `statusMessage` is recorded even without I/O capture, and errors can hold secrets.
        span?.update({
          level: "ERROR",
          statusMessage: summarizeBody(sanitizeErrorMessage(message)),
        });
        span?.end();
      } catch (err) {
        console.warn("[langfuse] tool span error end failed:", toMessage(err));
      }
    },
  };
}

/** Dispatch branches that stop before a tool executes. */
export type DispatchRejectionOutcome =
  | "unknown_tool"
  | "inactive_tool"
  | "not_allowed"
  | "invalid_input"
  | "rejected"
  | "feature_disabled"
  | "failed";

/** A user rejection or a disabled tier (ADR-0074) is expected, so it is not a warning. */
const DISPATCH_OUTCOME_LEVEL = {
  unknown_tool: "WARNING",
  inactive_tool: "WARNING",
  not_allowed: "WARNING",
  invalid_input: "WARNING",
  rejected: "DEFAULT",
  feature_disabled: "DEFAULT",
  failed: "ERROR",
} satisfies Record<DispatchRejectionOutcome, "DEFAULT" | "WARNING" | "ERROR">;

export interface DispatchRejectionInput {
  /** Also the trace id. */
  runId: string;
  /** For an undeclared tool, pass a placeholder like `<unknown>`, not the raw model string. */
  toolName: string;
  /** Sanitized, bounded name hint for an unknown tool. */
  candidateToolName?: string | undefined;
  toolCallId: string;
  outcome: DispatchRejectionOutcome;
  reason: string;
  /** PII-free fingerprint, always recorded, so repeats of one broken call group together. */
  signature: string;
  userId?: string | undefined;
  /** `boss` or a sub-agent name. */
  caller?: string | undefined;
  stepId?: string | undefined;
  /** Attached only when I/O capture is on. */
  detail?: unknown;
  /** Attached only when I/O capture is on. */
  input?: unknown;
  startedAt: Date;
}

/** Exported so tests can check the privacy gates. */
export function buildDispatchRejectionSpanPayload(
  args: DispatchRejectionInput,
  captureIo: boolean,
) {
  return {
    span: {
      name: `tool:${args.toolName}`,
      startTime: args.startedAt,
      input: captureIo ? args.input : undefined,
      metadata: {
        kind: "tool",
        outcome: args.outcome,
        rejectionSignature: args.signature,
        toolName: args.toolName,
        candidateToolName: args.candidateToolName,
        toolCallId: args.toolCallId,
        caller: args.caller,
        userId: args.userId,
        runId: args.runId,
        stepId: args.stepId,
        // Zod issues can echo the input values.
        detail: captureIo ? args.detail : undefined,
      },
    },
    end: {
      level: DISPATCH_OUTCOME_LEVEL[args.outcome],
      statusMessage: captureIo ? summarizeBody(sanitizeErrorMessage(args.reason)) : args.signature,
    },
  };
}

/**
 * Emit a zero-length `tool:<name>` span for a call that never executed.
 * Without I/O capture, `statusMessage` is the signature, because the reason can hold user content.
 */
export function recordDispatchRejection(args: DispatchRejectionInput): void {
  const runtime = getRuntime();

  if (!runtime) return;
  const captureIo = shouldCaptureIo();

  try {
    const payload = buildDispatchRejectionSpanPayload(args, captureIo);

    const span = startRunAttributedObservation(args.runId, () =>
      startObservation(
        payload.span.name,
        {
          ...(payload.span.input !== undefined ? { input: payload.span.input } : {}),
          metadata: payload.span.metadata,
        },
        {
          asType: "span",
          startTime: payload.span.startTime,
          parentSpanContext: traceSpanContext(args.runId),
        },
      ),
    );

    span.update({ level: payload.end.level, statusMessage: payload.end.statusMessage });
    span.end();
  } catch (err) {
    console.warn("[langfuse] dispatch rejection span failed:", toMessage(err));
  }
}

// Runtime spans time the non-LLM work in a run (dispatch, waits, queue), named
// `runtime.<area>.<op>`.

export type RuntimeSpanLevel = "DEFAULT" | "WARNING" | "ERROR";

/** Primitives only, so no raw payload (possible PII) can reach a runtime span. */
export type RuntimeMetaValue = string | number | boolean | null | undefined;

export interface RuntimeSpanInput {
  /** Also the trace id. */
  runId: string;
  /** For example `runtime.dispatch.batch`. */
  name: string;
  startedAt: Date;
  metadata?: Record<string, RuntimeMetaValue>;
  /** Attached only when I/O capture is on. */
  input?: unknown;
}

export interface RuntimeSpanEndArgs {
  /** Recorded as `metadata.status`. */
  status: string;
  level?: RuntimeSpanLevel | undefined;
  metadata?: Record<string, RuntimeMetaValue> | undefined;
  /** Attached only when I/O capture is on. */
  output?: unknown;
}

export interface RuntimeSpanCloser {
  end(args: RuntimeSpanEndArgs): void;
}

export function buildRuntimeSpanPayload(input: RuntimeSpanInput, captureIo: boolean) {
  return {
    name: input.name,
    startTime: input.startedAt,
    input: captureIo ? input.input : undefined,
    metadata: {
      kind: "runtime" as const,
      runId: input.runId,
      ...input.metadata,
    },
  };
}

const DEFAULT_RUNTIME_SPAN_LEVEL: RuntimeSpanLevel = "DEFAULT";

export function buildRuntimeSpanEndPayload(args: RuntimeSpanEndArgs, captureIo: boolean) {
  return {
    level: args.level ?? DEFAULT_RUNTIME_SPAN_LEVEL,
    output: captureIo ? args.output : undefined,
    metadata: { status: args.status, ...args.metadata },
  };
}

/** Open a runtime span under the run trace. SDK errors are swallowed. */
export function startRuntimeSpan(input: RuntimeSpanInput): RuntimeSpanCloser {
  const runtime = getRuntime();

  if (!runtime) {
    return {
      end() {
        /* no-op when keys missing */
      },
    };
  }

  const captureIo = shouldCaptureIo();
  let span: LangfuseSpan | null = null;

  try {
    const payload = buildRuntimeSpanPayload(input, captureIo);

    span = startRunAttributedObservation(input.runId, () =>
      startObservation(
        payload.name,
        {
          ...(payload.input !== undefined ? { input: payload.input } : {}),
          metadata: payload.metadata,
        },
        {
          asType: "span",
          startTime: payload.startTime,
          parentSpanContext: traceSpanContext(input.runId),
        },
      ),
    );
  } catch (err) {
    console.warn("[langfuse] runtime span start failed:", toMessage(err));
  }

  return {
    end(args) {
      try {
        const end = buildRuntimeSpanEndPayload(args, captureIo);

        span?.update({
          level: end.level,
          ...(end.output !== undefined ? { output: end.output } : {}),
          metadata: end.metadata,
        });
        span?.end();
      } catch (err) {
        console.warn("[langfuse] runtime span end failed:", toMessage(err));
      }
    },
  };
}

/** Send pending events. Call it before a script exits. */
export async function flushLangfuse(): Promise<void> {
  const runtime = getRuntime();

  if (!runtime) return;

  try {
    await runtime.provider.forceFlush();
  } catch (err) {
    console.warn("[langfuse] flush failed:", toMessage(err));
  }
}

export async function shutdownLangfuse(): Promise<void> {
  const runtime = getRuntime();

  if (!runtime) return;

  try {
    await runtime.provider.shutdown();
  } catch {
    /* swallow */
  }
}

/**
 * Map each `CallKind` to its call shape. `briefing` is a cost bucket (ADR-0041), not a shape,
 * so a `call_kind:llm` filter must still find briefing calls.
 */
const CALL_SHAPE = {
  llm: "llm",
  embedding: "embedding",
  web_search: "web_search",
  transcription: "transcription",
  tool_api: "tool_api",
  briefing: "llm",
} satisfies Record<CallKind, string>;

/** Trace tags: `role:`, `call_kind:` (the shape), and `cost_kind:` for a cost bucket. */
export function traceTags(meta: MeteredMeta): string[] | undefined {
  const tags: string[] = [];

  if (meta.role) tags.push(`role:${meta.role}`);

  if (meta.kind) {
    const shape = CALL_SHAPE[meta.kind];
    tags.push(`call_kind:${shape}`);

    if (meta.kind !== shape) tags.push(`cost_kind:${meta.kind}`);
  }

  return tags.length > 0 ? tags : undefined;
}

/** One trace per run. An ad-hoc call keys on its idempotency key, so retries share a trace. */
export function resolveTraceId(meta: MeteredMeta): string {
  return meta.runId ?? `adhoc:${meta.idempotencyKey ?? randomUUID()}`;
}

/** A run mixes models, so its trace is `run:<id>`. An ad-hoc trace has one call and uses its name. */
export function resolveTraceName(meta: MeteredMeta): string {
  return meta.runId ? `run:${meta.runId}` : (meta.name ?? `${meta.provider}/${meta.model}`);
}

/** Trace id, name, and attributes for a call. `id` is hashed by `langfuseTraceId`. */
export function buildTracePayload(meta: MeteredMeta) {
  const tags = traceTags(meta);

  return {
    id: resolveTraceId(meta),
    name: resolveTraceName(meta),
    ...(meta.userId !== undefined ? { userId: meta.userId } : {}),
    // No `runId` fallback: that would make a one-trace session per background run.
    ...(meta.sessionId !== undefined ? { sessionId: meta.sessionId } : {}),
    ...(tags !== undefined ? { tags } : {}),
  };
}

export function buildGenerationPayload(args: {
  meta: MeteredMeta;
  startedAt: Date;
  captureIo: boolean;
}) {
  const { meta, startedAt, captureIo } = args;
  const modelParameters = stripParams(meta.requestMeta);

  return {
    name: meta.name ?? `${meta.provider}/${meta.model}`,
    model: meta.model,
    ...(modelParameters !== undefined ? { modelParameters } : {}),
    startTime: startedAt,
    ...(captureIo ? { input: meta.input } : {}),
    metadata: {
      kind: meta.kind,
      role: meta.role,
      userId: meta.userId,
      runId: meta.runId,
      stepId: meta.stepId,
      attempt: meta.attempt,
      idempotencyKey: meta.idempotencyKey,
    },
  };
}

export function buildGenerationEndPayload(args: {
  meta: MeteredMeta;
  usage?: CallUsage | undefined;
  costUsd: number;
  output?: unknown;
  responseMeta?: JsonObject | undefined;
  servedModel?: string | undefined;
  captureIo: boolean;
}) {
  const { meta, usage, costUsd, output, responseMeta, servedModel, captureIo } = args;
  // After a fallback, stamp the model that ran and keep the requested one in metadata.
  const servedDiverged = servedModel != null && servedModel !== meta.model;
  const metadata = servedDiverged ? { ...responseMeta, requestedModel: meta.model } : responseMeta;

  return {
    ...(servedDiverged ? { model: servedModel } : {}),
    ...(usage
      ? {
          // Without `cacheWrite`, a cache miss looks like plain input.
          usageDetails: {
            input: usage.inputTokens ?? 0,
            output: usage.outputTokens ?? 0,
            cached: usage.cachedInputTokens ?? 0,
            cacheWrite: usage.cacheWriteInputTokens ?? 0,
          },
        }
      : {}),
    costDetails: { total: costUsd },
    ...(captureIo ? { output } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

/** Langfuse takes only `string | number`, so booleans and string arrays are coerced, not dropped. */
type LangfuseModelParam = string | number;

function stripParams(
  meta: JsonObject | undefined,
): { [key: string]: LangfuseModelParam } | undefined {
  if (!meta) return undefined;
  const skip = new Set(["prompt", "messages", "system"]);
  const out: { [key: string]: LangfuseModelParam } = {};

  for (const [k, v] of Object.entries(meta)) {
    if (skip.has(k)) continue;

    if (typeof v === "string" || typeof v === "number") {
      out[k] = v;
    } else if (typeof v === "boolean") {
      out[k] = String(v);
    } else if (Array.isArray(v)) {
      // Keep only all-string arrays; the length check drops mixed ones.
      const strings = toStringArray(v);

      if (strings.length === v.length) out[k] = strings.join(", ");
    }
    // Objects and mixed arrays are dropped.
  }

  return out;
}
