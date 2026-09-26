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
 * Lazy-init Langfuse tracing. We build the SDK once per process when the keys
 * are present; missing keys make the rest of `metered()` a tracing no-op — the
 * `api_call_log` row still lands. Per ADR-0023 (and confirmed in m6): tracing
 * wires alongside metering, keys gate emission.
 *
 * This is JS/TS SDK v5 (#1130), which is OpenTelemetry-based: `startObservation`
 * builds the observation tree, and a `LangfuseSpanProcessor` exports spans.
 * The provider is set on Langfuse's own isolated tracer provider
 * (`setLangfuseTracerProvider`) instead of the process-global one, so it never
 * replaces the OTel provider that `Sentry.init` installs in
 * `apps/server/src/instrument.ts`.
 *
 * `environment` and `release` are SDK config in v5, not per-trace attributes
 * (the v3 `client.trace({ environment })` and the removed
 * `updateActiveTrace({ release, environment })`); they ride the processor,
 * which reads `LANGFUSE_TRACING_ENVIRONMENT` / `LANGFUSE_RELEASE`.
 *
 * **Four functions here open observations, and all four must go through
 * `startRunAttributedObservation`** so each carries its run's `sessionId` / `userId` /
 * `tags`: `startLangfuseSpan` (which also publishes that identity), `startToolSpan`,
 * `recordDispatchRejection`, and `startRuntimeSpan`. A fifth opener added without it
 * ships unattributed, which is invisible in the UI — filtering a trace by role or by
 * session then silently drops it.
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
      // Stamp every trace with the deploy environment (#226) so traces never
      // blur once multiple targets report. `NODE_ENV` only separates
      // development|production|test, but staging/preview/prod all run with
      // `NODE_ENV=production`, so prefer the dedicated
      // `LANGFUSE_TRACING_ENVIRONMENT` slug per deploy target and fall back to
      // `NODE_ENV` only when it's unset (#226 review).
      environment: env.LANGFUSE_TRACING_ENVIRONMENT ?? env.NODE_ENV,
      ...(env.LANGFUSE_RELEASE ? { release: env.LANGFUSE_RELEASE } : {}),
    });

    const provider = new BasicTracerProvider({ spanProcessors: [processor] });

    // `propagateAttributes` reads the OTel active context. NodeSDK (and Sentry,
    // in `apps/server/src/instrument.ts`) install an AsyncLocalStorage context
    // manager, but scripts and tests may run without either, so register the
    // standard one. This is a no-op when a manager is already registered.
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

/**
 * Test-only: point the helpers at a caller-owned provider (an in-memory span
 * recorder) instead of the env-gated real one. Returns a restore closure.
 * Mirrors `_resetPriceCacheForTests`.
 */
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
 * Derive a valid 32-hex OTel trace id from a logical trace id (`runId` or
 * `adhoc:<key>`). v5 has no `client.trace()` upsert: an OTel trace *is* the set
 * of observations that share `traceId`, and a span inherits that id from its
 * `parentSpanContext`. The parent span id is never a real observation — the
 * Langfuse docs bless exactly this shape for trace-id inheritance, so every
 * observation of a run lands at the root of one deterministic trace.
 *
 * Hashing matches `w3cTraceId` in `packages/assistant/src/connections/mcp/trace.ts`,
 * so the id an MCP peer sees in its `traceparent` is now the same id this trace
 * uses (before v5 the two diverged).
 */
export function langfuseTraceId(logicalTraceId: string): string {
  const derived = createHash("sha256").update(logicalTraceId).digest("hex").slice(0, 32);

  return /^0+$/.test(derived) ? "00000000000000000000000000000001" : derived;
}

function traceSpanContext(logicalTraceId: string): SpanContext {
  const digest = createHash("sha256").update(logicalTraceId).digest("hex");

  return {
    traceId: langfuseTraceId(logicalTraceId),
    // Any valid 16-hex string works; the parent span does not exist and is only
    // used for trace-id inheritance.
    spanId: digest.slice(32, 48),
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  };
}

/**
 * Trace-level attributes for `propagateAttributes` — the v5 replacement for the
 * v3 `client.trace()` upsert. v5 propagates `userId` / `sessionId` / `tags` /
 * `traceName` to every observation in scope, so they are set on each
 * observation this module creates rather than once on the trace.
 *
 * `public` has no call site today; v5 exposes it separately as
 * `setTraceAsPublic()` / `setActiveTraceAsPublic()` and it must not be passed as
 * a trace attribute (removed in v5). Trace input/output is likewise not set
 * here: in v5 the root observation's input/output *is* the trace's.
 */
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
 * Apply trace attributes to the observation `fn` creates, without writing them
 * to whatever OTel span is active process-wide.
 *
 * `propagateAttributes` does two things: it seeds the OTel context the
 * `LangfuseSpanProcessor` reads in `onStart`, and it calls `setAttribute` on the
 * active span. Sentry owns the process-global provider, so the active span is
 * normally Sentry's — running from `ROOT_CONTEXT` hides it, leaving the SDK
 * nothing to stamp while the context values still ride into the Langfuse
 * observation. Without this, `user.id` / `session.id` / `langfuse.trace.*` leak
 * onto Sentry spans.
 */
function withTraceAttributes<T>(params: PropagateAttributesParams, fn: () => T): T {
  return context.with(ROOT_CONTEXT, () => propagateAttributes(params, fn));
}

/** One run's trace-level identity, as the generation established it. */
type RunTraceIdentity = {
  name: string;
  userId?: string | undefined;
  sessionId?: string | undefined;
  tags?: string[] | undefined;
};

/**
 * A run's identity, held between the generation that established it and the spans
 * that follow.
 *
 * `withTraceAttributes` seeds OTel context for the duration of one call and
 * returns, so it cannot carry `sessionId` / `userId` / `tags` to a span opened
 * later — which is every tool and runtime span, since those run in the
 * `dispatch-tools` step after the generation has already returned. Threading the
 * identity through all four span seams instead would touch `executor.ts` and
 * `worker.ts`; this keeps the change inside this module.
 *
 * Every span input already carries `runId`, and `resolveTraceId` returns
 * `meta.runId` for a run, so the generation's payload is keyed by the same string
 * the spans look up.
 *
 * **Process-local, and the resume path is designed to cross instances.**
 * `AGENT_WORKER_CONCURRENCY` is in-process concurrency, so every worker in one
 * server shares this map. But `execution/worker.ts` documents that "anything left
 * mid-flight by a previous deploy gets picked up", so a run resumed by a different
 * server instance after a deploy finds no entry and its spans open bare. That is a
 * silent observability gap on scale-out, not an error. A shared store is the fix; it
 * is deliberately not built here.
 *
 * **The entry is the most recent attribution seen for a run, not a canonical one.**
 * Calls for the same run do not all carry the same fields: the brief workflow passes
 * `runId` with no `sessionId` (workflow-scoped, not thread-scoped), so a brief's
 * entry carries no session by design. Nothing merges a previous entry forward, so a
 * later call with fewer fields narrows it.
 *
 * **Every opener must route through `startRunAttributedObservation`.** There are four
 * today — `startLangfuseSpan`, `startToolSpan`, `recordDispatchRejection`,
 * `startRuntimeSpan` — and a fifth added without it ships unattributed, which is the
 * defect this map exists to remove.
 */
const runIdentities = new Map<string, { at: number; identity: RunTraceIdentity }>();

/**
 * Sized by the longest park a run sits through, not by how long a turn usually takes.
 * A staged tool call opens its span on *resume*, not at decision time
 * (`tool-runtime/internal/dispatch/pipeline.ts:1455`), and the resume re-enters
 * `dispatch-tools` with no intervening generation — so the identity has to still be
 * here when the run wakes. That park is bounded by `APPROVAL_EXPIRY_MS` (24h, ADR-0034);
 * `AWAIT_SUB_AGENT_CEILING_MS` is 6 minutes and a chat turn is seconds. An earlier
 * 15-minute value read as reasonable and was 1/96th of the case it claimed to cover.
 */
const RUN_IDENTITY_TTL_MS = APPROVAL_EXPIRY_MS;

/** Amortises the sweep to once per interval rather than once per generation. */
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

/**
 * Open an observation carrying its run's trace attributes, or open it bare when
 * the run never established any. A miss is today's behaviour, not a new one — a
 * span that opens before its run's first generation, or a run with no LLM call
 * at all, has no identity to propagate and must not invent one.
 */
function startRunAttributedObservation<T>(runId: string, create: () => T): T {
  const entry = runIdentities.get(runId);

  return entry ? withTraceAttributes(traceAttributeParams(entry.identity), create) : create();
}

export interface LangfuseSpanInput {
  meta: MeteredMeta;
  startedAt: Date;
}

/**
 * Open a Langfuse generation span. Use `runId` as the trace id so all
 * calls inside one agent run group into a single tree (boss + sub-agents
 * inherited from m13 will hang off the same trace via parent links).
 *
 * Returns a closer with two outcomes — `success(usage, costUsd, output)`
 * or `error(message)`. Both are best-effort: any throw inside the
 * Langfuse SDK is swallowed so tracing failures never break the call.
 */
export interface LangfuseSpanCloser {
  success(args: {
    usage?: CallUsage | undefined;
    costUsd: number;
    /** Full completion — only attached to the span when I/O capture is on. */
    output?: unknown;
    /** Small response metadata (finish_reason, tool-call count) — always attached. */
    responseMeta?: JsonObject | undefined;
    /**
     * Model the request actually resolved to (#216). When a `withFallback`
     * cascade switches providers mid-call, `metered()` reconciles the served
     * id and passes it here so the generation's `model` reflects what ran —
     * not the nominal id the span opened with. Defaults to the requested id
     * when undefined or unchanged.
     */
    servedModel?: string | undefined;
  }): void;
  error(message: string): void;
}

/**
 * Whether to attach full prompt/completion text to spans. Gated by
 * `LANGFUSE_CAPTURE_IO` (#215) so the default stays I/O-free and prompt
 * content (potential PII) never leaves the box unless explicitly enabled
 * on a self-hosted instance.
 */
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
  // `getRuntime()` above proves the provider is live; the calls below are still
  // wrapped so a misconfigured SDK can't crash the call site.
  const captureIo = shouldCaptureIo();
  const tracePayload = buildTracePayload(meta);
  const generationPayload = buildGenerationPayload({ meta, startedAt, captureIo });
  let generation: LangfuseGeneration | null = null;

  try {
    // No v3-style trace upsert exists in v5. Trace identity comes from the
    // synthetic `parentSpanContext`, and the trace-level name/user/session/tags
    // ride the propagated context for this observation. Repeated calls in one run
    // all hash to the same trace id, and Langfuse unions tags across
    // observations, so a multi-role run accumulates every surface tag (#226).
    // `withTraceAttributes` keeps those attributes off the process-global span.
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

  // Publish the run's identity so the tool and runtime spans that follow in the
  // dispatch step can carry it too. Keyed by `runId` rather than the resolved
  // trace id so an ad-hoc call, which has no run and no spans to serve, does not
  // take an entry.
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

        // v5 splits the v3 `generation.end(payload)` into `update(attributes)`
        // then `end()`. `usage` is a v3-only field — v5 reads `usageDetails`.
        // For an ad-hoc trace this generation is the app root, so its
        // input/output are the trace's (#226); no separate trace IO write.
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

/**
 * A tool call to open a span for under the run trace (#214). Tool calls
 * execute in the dispatcher *after* the LLM generation that proposed them,
 * so without this they appear in no trace at all — the run tree shows the
 * boss's generations but none of the work they triggered.
 */
export interface ToolSpanInput {
  /** Run id — doubles as the Langfuse trace id this span hangs under. */
  runId: string;
  toolName: string;
  /** Model-supplied id for the call; deduplicates a call across re-attempts. */
  toolCallId: string;
  userId?: string;
  /** `boss` or a named sub-agent — surfaced in span metadata. */
  caller?: string;
  /** Executor step that owns the dispatch — audit only. */
  stepId?: string;
  /** Tool arguments. Only attached when `LANGFUSE_CAPTURE_IO` is on (PII). */
  input?: unknown;
  startedAt: Date;
}

export interface ToolSpanCloser {
  /**
   * Tool returned; `output` is attached only when I/O capture is on. `metadata`
   * (when given) is merged onto the span's metadata and is recorded ALWAYS —
   * independent of the I/O gate — so it must carry only non-PII, structural
   * signal (e.g. the ADR-0074 passthrough truncation "thermometer").
   */
  success(output?: unknown, metadata?: JsonObject): void;
  error(message: string): void;
}

/**
 * Open a Langfuse span for a single tool execution, nested under the run
 * trace (#214). Mirrors `startLangfuseSpan`'s contract: a no-op closer when
 * keys are absent, and every SDK call swallowed so tracing can't break the
 * dispatch path.
 *
 * Tool I/O (args + result) can carry PII, so it rides the same
 * `LANGFUSE_CAPTURE_IO` gate as generation I/O — off by default, the span
 * still records name/timing/metadata.
 */
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
    // The boss LLM turn that proposed this call already created the run trace
    // (chat's generation step precedes tool dispatch). The synthetic parent
    // context still carries that trace's id, so a tool that somehow runs before
    // any generation joins the same trace instead of orphaning. The parent span
    // does not exist — by design, only for trace-id inheritance.
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
        // Structural metadata (e.g. the truncation thermometer) is recorded
        // regardless of the I/O gate; v5 merges `update` metadata onto the set
        // from span open, so the `kind: "tool"` block is preserved.
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
        // A tool error can carry user content, response fragments, or secrets
        // from an integration. `statusMessage` is recorded even with I/O capture
        // off, so redact + bound here (the funnel) so no raw error reaches
        // Langfuse regardless of the caller. `summarizeBody` strips secrets and
        // caps length; `sanitizeErrorMessage` strips NUL-byte poison.
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

/**
 * The dispatch branches that short-circuit *before* a tool ever executes
 * (#345). `startToolSpan` only covers the execute path, so these — an
 * undeclared/unregistered tool, a Zod/access rejection, a policy/expiry
 * rejection, or a post-approval reparse failure — produced no span at all,
 * leaving a whole class of "naive tool error" invisible in the trace tree
 * (found only by manual chat-card audit). `recordDispatchRejection` makes
 * every attempt a node.
 */
export type DispatchRejectionOutcome =
  | "unknown_tool"
  | "inactive_tool"
  | "not_allowed"
  | "invalid_input"
  | "rejected"
  | "feature_disabled"
  | "failed";

/**
 * Trace severity per outcome. A schema/access/unknown miss or a failed
 * reparse is an anomaly (WARNING/ERROR); a policy/expiry rejection is an
 * expected user decision, not an error (DEFAULT), but still worth a node so
 * the "bounce on the same wall" pattern is countable.
 */
const DISPATCH_OUTCOME_LEVEL = {
  unknown_tool: "WARNING",
  inactive_tool: "WARNING",
  not_allowed: "WARNING",
  invalid_input: "WARNING",
  rejected: "DEFAULT",
  // The user turned this tier off (ADR-0074, default-OFF). An expected setting,
  // not an anomaly — a node worth counting but not a warning.
  feature_disabled: "DEFAULT",
  failed: "ERROR",
} satisfies Record<DispatchRejectionOutcome, "DEFAULT" | "WARNING" | "ERROR">;

export interface DispatchRejectionInput {
  /** Run id — doubles as the Langfuse trace id this span hangs under. */
  runId: string;
  /**
   * Safe tool identity used for the observation name and grouping. For a raw
   * undeclared model string, callers must pass a stable placeholder such as
   * `<unknown>` and put any sanitized/bounded hint in `candidateToolName`.
   */
  toolName: string;
  /** Optional sanitized + bounded model-supplied name hint for unknown tools. */
  candidateToolName?: string | undefined;
  /** Model-supplied id for the call; deduplicates a call across re-attempts. */
  toolCallId: string;
  /** Dispatch branch that short-circuited before execution. */
  outcome: DispatchRejectionOutcome;
  /** Enriched, human-readable reason. Redacted + bounded before it reaches Langfuse. */
  reason: string;
  /**
   * Stable, PII-free fingerprint of the rejection (e.g. tool + outcome + Zod
   * issue codes/paths). Always recorded so identical repeats — the boss
   * re-proposing the same broken call — group and count in the Traces view.
   */
  signature: string;
  userId?: string | undefined;
  /** `boss` or a named sub-agent — surfaced in span metadata. */
  caller?: string | undefined;
  /** Executor step that owns the dispatch — audit only. */
  stepId?: string | undefined;
  /** Structured detail (e.g. Zod issues). Only attached when I/O capture is on (PII). */
  detail?: unknown;
  /** The proposed input that was rejected. Only attached when I/O capture is on (PII). */
  input?: unknown;
  startedAt: Date;
}

/** Pure payload builder for rejection spans; kept exported so privacy gates are testable. */
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
        // Zod issues / structured detail can echo the proposed input values.
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
 * Emit a zero-duration span for a dispatch attempt that never reached execute
 * (#345). Shares the `tool:<name>` naming with execution spans so attempts and
 * executions of the same tool group together; `metadata.outcome` +
 * `metadata.rejectionSignature` + the span `level` distinguish and bucket them.
 *
 * Fire-and-forget and fully swallowed — like `startToolSpan`, tracing must never
 * break the dispatch path. The reason string can carry user content from
 * custom validators, so it rides the `LANGFUSE_CAPTURE_IO` gate; with capture
 * off, `statusMessage` is the structural, PII-free rejection signature. The
 * structured `detail` and `input` use the same gate.
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

    // v5 splits the v3 `span.end(attributes)` into `update` + `end`.
    span.update({ level: payload.end.level, statusMessage: payload.end.statusMessage });
    span.end();
  } catch (err) {
    console.warn("[langfuse] dispatch rejection span failed:", toMessage(err));
  }
}

/**
 * Non-LLM runtime observations (#406, PRD #405). The trace tree already covers
 * the execution spine — LLM generations (`startLangfuseSpan`), tool executions
 * (`startToolSpan`), and dispatch rejections (`recordDispatchRejection`) — but
 * the deterministic orchestration *between* those (dispatch batch overhead,
 * scratchpad round-trips, approval/sub-agent waits, queue/lease timing, lazy
 * tool lookup) is invisible: an operator can't tell whether a run spent its
 * wall-clock in the model, a tool, or orchestration glue. `startRuntimeSpan` is
 * the shared helper for that class — a plain span nested under the run trace,
 * stable-named (`runtime.<area>.<op>`), carrying only bounded, PII-free metadata.
 *
 * Same privacy posture as the sibling helpers: full I/O rides the
 * `LANGFUSE_CAPTURE_IO` gate (off by default); metadata is timings / counts /
 * statuses / hashes only, never raw payloads or keys. Every SDK call is
 * swallowed so a tracing fault can never break the orchestration path it
 * observes. Span duration is derived by Langfuse from start/end times, so
 * callers need not compute it.
 */

/** Langfuse observation level for a runtime span's terminal status. */
export type RuntimeSpanLevel = "DEFAULT" | "WARNING" | "ERROR";

/**
 * Bounded metadata value for a runtime span. Deliberately primitive-only so the
 * type system keeps raw objects / keys / values (potential PII) off the span —
 * runtime spans record counts, durations, statuses, and hashes, not payloads.
 */
export type RuntimeMetaValue = string | number | boolean | null | undefined;

export interface RuntimeSpanInput {
  /** Run id — doubles as the Langfuse trace id this span hangs under. */
  runId: string;
  /** Stable observation name, e.g. `runtime.dispatch.batch`. */
  name: string;
  startedAt: Date;
  /** Bounded, PII-free metadata (timings / counts / statuses / hashes). */
  metadata?: Record<string, RuntimeMetaValue>;
  /** Full input — only attached when `LANGFUSE_CAPTURE_IO` is on. */
  input?: unknown;
}

export interface RuntimeSpanEndArgs {
  /** Terminal status, recorded in `metadata.status` (e.g. "committed", "staged", "error"). */
  status: string;
  /** Observation level. Defaults to `DEFAULT`; pass `ERROR` for a faulted span. */
  level?: RuntimeSpanLevel | undefined;
  /** Additional bounded metadata merged at end (final counts / durations). */
  metadata?: Record<string, RuntimeMetaValue> | undefined;
  /** Full output — only attached when `LANGFUSE_CAPTURE_IO` is on. */
  output?: unknown;
}

export interface RuntimeSpanCloser {
  end(args: RuntimeSpanEndArgs): void;
}

/** Pure builder for a runtime span's opening attributes. Exported for tests. */
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

/** Pure builder for the terminal `span.end()` payload. Exported for tests. */
const DEFAULT_RUNTIME_SPAN_LEVEL: RuntimeSpanLevel = "DEFAULT";

export function buildRuntimeSpanEndPayload(args: RuntimeSpanEndArgs, captureIo: boolean) {
  return {
    level: args.level ?? DEFAULT_RUNTIME_SPAN_LEVEL,
    output: captureIo ? args.output : undefined,
    metadata: { status: args.status, ...args.metadata },
  };
}

/**
 * Open a runtime span under the run trace (#406). No-op closer when Langfuse
 * keys are absent (mirrors `startToolSpan`). The synthetic parent context
 * carries the run trace id, so the span joins the trace the boss generation
 * already created (or creates it first for a run with no generation yet). Every
 * SDK call is swallowed.
 */
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

        // v5 splits the v3 `span.end(payload)` into `update` + `end`.
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

/**
 * Best-effort flush so a CLI script (smoke tests, sync-prices) doesn't
 * exit before in-flight Langfuse events are sent. Server processes
 * call this on graceful shutdown.
 */
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
 * `CallKind` overloads two dimensions: call *shape* (llm/embedding/web_search/
 * transcription/tool_api) and cost *bucket* (`briefing`, added per ADR-0041 so
 * daily-briefing spend rolls up apart from per-run LLM cost). For trace tags
 * these must stay separate, or filtering breaks: the briefing agent emits
 * `kind:"llm"` while briefing compose emits `kind:"briefing"`, yet both are LLM
 * calls — a `kind:llm` filter would silently miss compose (#226 review). This
 * map projects every kind onto its underlying shape; the cost-bucket kinds map
 * to the shape they actually run as and are surfaced under a separate
 * `cost_kind:` namespace.
 */
const CALL_SHAPE = {
  llm: "llm",
  embedding: "embedding",
  web_search: "web_search",
  transcription: "transcription",
  tool_api: "tool_api",
  // A briefing call is an LLM generation; `briefing` is only a cost bucket.
  briefing: "llm",
} satisfies Record<CallKind, string>;

/**
 * Build the filterable trace tags from a call's attribution (#226). Three
 * independent namespaces so the Traces filter slices cleanly:
 * - `role:<surface>` — chat/triage/briefing/cold_start/…
 * - `call_kind:<shape>` — the call shape (llm/embedding/web_search/…), derived
 *   so cost-bucket kinds normalize to their real shape.
 * - `cost_kind:<bucket>` — only when `kind` is a cost bucket that isn't itself
 *   a shape (e.g. `briefing`), so spend-bucket filtering stays independent of
 *   shape filtering.
 * Returns undefined when nothing is present so we don't stamp an empty array.
 */
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

/**
 * Trace id for a call. `runId` groups every call inside one agent run into a
 * single trace tree; ad-hoc calls (no run) get a unique id keyed off the
 * idempotency key (stable across retries) or a fresh UUID. `Date.now()` would
 * collide for concurrent same-ms calls and merge unrelated traces.
 */
export function resolveTraceId(meta: MeteredMeta): string {
  return meta.runId ?? `adhoc:${meta.idempotencyKey ?? randomUUID()}`;
}

/**
 * Trace name. A run mixes models and roles (boss + sub-agents + compactor), so
 * naming the trace after any single call's `provider/model` would churn as each
 * call upserts the trace. `run:<id>` is stable by construction. Ad-hoc traces
 * hold exactly one generation, so the descriptive name is more useful there.
 */
export function resolveTraceName(meta: MeteredMeta): string {
  return meta.runId ? `run:${meta.runId}` : (meta.name ?? `${meta.provider}/${meta.model}`);
}

/**
 * Trace-level identity and attributes for a call. Pure, for testability. In v5
 * `id` is hashed into the OTel trace id via `langfuseTraceId`, and the rest map
 * onto `propagateAttributes`.
 *
 * Trace input/output is not built here: in v5 it is the root observation's I/O,
 * not a separate trace attribute.
 */
export function buildTracePayload(meta: MeteredMeta) {
  const tags = traceTags(meta);

  return {
    id: resolveTraceId(meta),
    name: resolveTraceName(meta),
    ...(meta.userId !== undefined ? { userId: meta.userId } : {}),
    // Only group under a Sessions-view entry when the caller supplied a real
    // session id (chat passes `threadId`). Falling back to `runId` would mint a
    // one-trace "session" per background/job run that duplicates the trace and
    // pollutes the Sessions view — Langfuse sessions are for grouping *multiple*
    // traces under a real product session (#226 review).
    ...(meta.sessionId !== undefined ? { sessionId: meta.sessionId } : {}),
    // Promote role/kind to filterable trace tags (#226) — they otherwise only
    // live in generation metadata, which the Traces filter can't slice by.
    ...(tags !== undefined ? { tags } : {}),
  };
}

/** Attributes for the generation's opening `startObservation`. Pure, for testability. */
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

/** Payload for `generation.end()` on success. Pure, for testability. */
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
  // The span opened with the requested model; if the call actually resolved to
  // a different (registry-known) model via fallback, restamp the generation so
  // per-model cost/latency attributes correctly, and keep the requested id in
  // metadata for fallback debugging (#216).
  const servedDiverged = servedModel != null && servedModel !== meta.model;
  const metadata = servedDiverged ? { ...responseMeta, requestedModel: meta.model } : responseMeta;

  return {
    ...(servedDiverged ? { model: servedModel } : {}),
    ...(usage
      ? {
          // `cacheWrite` is the miss half of `cached`. Without it a trace shows
          // a cold call as plain input, hiding both the premium rate the
          // provider charged and the fact that the cache missed at all. The v3
          // `usage` field is not sent — v5 reads `usageDetails` only.
          usageDetails: {
            input: usage.inputTokens ?? 0,
            output: usage.outputTokens ?? 0,
            cached: usage.cachedInputTokens ?? 0,
            cacheWrite: usage.cacheWriteInputTokens ?? 0,
          },
        }
      : {}),
    // Cost in USD; Langfuse's `costDetails` accepts arbitrary keys.
    costDetails: { total: costUsd },
    // Full completion only when capture is on; the small response metadata
    // (finish_reason, tool-call count) is always useful.
    ...(captureIo ? { output } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

/**
 * v5 narrows `modelParameters` to `string | number` (v3 accepted booleans and
 * string arrays). Coerce instead of dropping so values like `stream: true` and
 * `stop: ["a","b"]` still reach the trace.
 */
type LangfuseModelParam = string | number;

function stripParams(
  meta: JsonObject | undefined,
): { [key: string]: LangfuseModelParam } | undefined {
  if (!meta) return undefined;
  // Drop fields that are too large or not relevant to the trace, and coerce
  // remaining values to the primitive shapes Langfuse accepts.
  const skip = new Set(["prompt", "messages", "system"]);
  const out: { [key: string]: LangfuseModelParam } = {};

  for (const [k, v] of Object.entries(meta)) {
    if (skip.has(k)) continue;

    if (typeof v === "string" || typeof v === "number") {
      out[k] = v;
    } else if (typeof v === "boolean") {
      out[k] = String(v);
    } else if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
      out[k] = toStringArray(v).join(", ");
    }
    // Anything else (objects, mixed arrays) is silently dropped — Langfuse
    // can't render them and including them broke the type contract.
  }

  return out;
}
