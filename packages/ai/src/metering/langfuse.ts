import { serverEnv } from "@alfred/env/server";
import { randomUUID } from "node:crypto";
import { Langfuse } from "langfuse";
import type { CallKind, CallUsage, MeteredMeta } from "./types";
import { sanitizeErrorMessage, summarizeBody, toMessage } from "@alfred/contracts";

/**
 * Lazy-init Langfuse client. We construct it once per process when the
 * keys are present; missing keys mean the rest of `metered()` becomes a
 * no-op for tracing — the `api_call_log` row still lands.
 *
 * Per ADR-0023 (and confirmed in m6): tracing wires alongside metering,
 * keys gate emission. When the keys are absent (local dev without LF
 * setup, CI), this module reports a `noop` instance so call sites stay
 * branch-free.
 */
let _client: Langfuse | "noop" | undefined;

function getClient(): Langfuse | null {
  if (_client === "noop") return null;
  if (_client) return _client;
  const env = serverEnv();
  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) {
    _client = "noop";
    return null;
  }
  _client = new Langfuse({
    publicKey: env.LANGFUSE_PUBLIC_KEY,
    secretKey: env.LANGFUSE_SECRET_KEY,
    baseUrl: env.LANGFUSE_HOST,
    // Stamp every trace with the deploy environment (#226) so traces never
    // blur once multiple targets report. `NODE_ENV` only separates
    // development|production|test, but staging/preview/prod all run with
    // `NODE_ENV=production`, so prefer the dedicated
    // `LANGFUSE_TRACING_ENVIRONMENT` slug per deploy target and fall back to
    // `NODE_ENV` only when it's unset (#226 review).
    environment: env.LANGFUSE_TRACING_ENVIRONMENT ?? env.NODE_ENV,
  });
  return _client;
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
    usage?: CallUsage;
    costUsd: number;
    /** Full completion — only attached to the span when I/O capture is on. */
    output?: unknown;
    /** Small response metadata (finish_reason, tool-call count) — always attached. */
    responseMeta?: Record<string, unknown>;
    /**
     * Model the request actually resolved to (#216). When a `withFallback`
     * cascade switches providers mid-call, `metered()` reconciles the served
     * id and passes it here so the generation's `model` reflects what ran —
     * not the nominal id the span opened with. Defaults to the requested id
     * when undefined or unchanged.
     */
    servedModel?: string;
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
  const client = getClient();
  if (!client) {
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
  // generation() in Langfuse v3 returns an object with .end()/.update().
  // We catch construction errors so a misconfigured SDK can't crash the
  // call site.
  const captureIo = shouldCaptureIo();
  const traceId = resolveTraceId(meta);
  const adhoc = isAdhocTrace(meta);
  let generation: ReturnType<Langfuse["generation"]> | null = null;
  try {
    // Upsert the parent trace first. `generation()` with a custom traceId
    // does NOT create the trace — Langfuse Cloud no longer auto-promotes
    // orphan observations, so without this the Traces view is empty and
    // runId grouping never materializes. Idempotent on `id`: every call in
    // one run collapses into a single trace tree. Only run-stable fields go
    // here; per-call identity (model) lives on the generation, so the repeated
    // upserts don't rewrite the trace with the last call's values. Tags are
    // unioned by Langfuse across upserts, so a multi-role run accumulates every
    // surface tag rather than the last writer winning.
    client.trace(buildTracePayload({ meta, captureIo }));
    generation = client.generation(buildGenerationPayload({ meta, startedAt, captureIo }));
  } catch (err) {
    console.warn("[langfuse] span start failed:", toMessage(err));
  }

  return {
    success({ usage, costUsd, output, responseMeta, servedModel }) {
      try {
        generation?.end(
          buildGenerationEndPayload({
            meta,
            usage,
            costUsd,
            output,
            responseMeta,
            servedModel,
            captureIo,
          }),
        );
        // Mirror the completion up to an ad-hoc trace's root (#226) so the
        // Traces view shows the call's I/O instead of the empty-root banner.
        if (captureIo && adhoc) {
          client.trace({ id: traceId, output });
        }
      } catch (err) {
        console.warn("[langfuse] span end failed:", toMessage(err));
      }
    },
    error(message) {
      try {
        generation?.end({ level: "ERROR", statusMessage: message });
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
  /** Tool returned; `output` is attached only when I/O capture is on. */
  success(output?: unknown): void;
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
  const client = getClient();
  if (!client) {
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
  let span: ReturnType<Langfuse["span"]> | null = null;
  try {
    // The boss LLM turn that proposed this call already upserted the
    // `run:<runId>` trace (chat's generation step precedes tool dispatch), so
    // the span nests under an existing trace. Upsert defensively by id anyway —
    // it's a merge keyed on id, so it never clobbers the trace's name/tags —
    // so a tool that somehow runs before any generation in the run still gets a
    // trace rather than an orphaned (and thus dropped) observation.
    client.trace({ id: args.runId });
    span = client.span({
      traceId: args.runId,
      name: `tool:${args.toolName}`,
      startTime: args.startedAt,
      input: captureIo ? args.input : undefined,
      metadata: {
        kind: "tool",
        toolName: args.toolName,
        toolCallId: args.toolCallId,
        caller: args.caller,
        userId: args.userId,
        runId: args.runId,
        stepId: args.stepId,
      },
    });
  } catch (err) {
    console.warn("[langfuse] tool span start failed:", toMessage(err));
  }

  return {
    success(output) {
      try {
        span?.end({ output: captureIo ? output : undefined });
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
        span?.end({ level: "ERROR", statusMessage: summarizeBody(sanitizeErrorMessage(message)) });
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
  | "failed";

/**
 * Trace severity per outcome. A schema/access/unknown miss or a failed
 * reparse is an anomaly (WARNING/ERROR); a policy/expiry rejection is an
 * expected user decision, not an error (DEFAULT), but still worth a node so
 * the "bounce on the same wall" pattern is countable.
 */
const DISPATCH_OUTCOME_LEVEL: Record<DispatchRejectionOutcome, "DEFAULT" | "WARNING" | "ERROR"> = {
  unknown_tool: "WARNING",
  inactive_tool: "WARNING",
  not_allowed: "WARNING",
  invalid_input: "WARNING",
  rejected: "DEFAULT",
  failed: "ERROR",
};

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
  candidateToolName?: string;
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
  userId?: string;
  /** `boss` or a named sub-agent — surfaced in span metadata. */
  caller?: string;
  /** Executor step that owns the dispatch — audit only. */
  stepId?: string;
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
      traceId: args.runId,
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
  const client = getClient();
  if (!client) return;
  const captureIo = shouldCaptureIo();
  try {
    // Defensive trace upsert (see startToolSpan) — keyed on id, never clobbers.
    client.trace({ id: args.runId });
    const payload = buildDispatchRejectionSpanPayload(args, captureIo);
    const span = client.span(payload.span);
    span.end(payload.end);
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
  level?: RuntimeSpanLevel;
  /** Additional bounded metadata merged at end (final counts / durations). */
  metadata?: Record<string, RuntimeMetaValue>;
  /** Full output — only attached when `LANGFUSE_CAPTURE_IO` is on. */
  output?: unknown;
}

export interface RuntimeSpanCloser {
  end(args: RuntimeSpanEndArgs): void;
}

/** Pure builder for the opening `client.span()` payload. Exported for tests. */
export function buildRuntimeSpanPayload(input: RuntimeSpanInput, captureIo: boolean) {
  return {
    traceId: input.runId,
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
export function buildRuntimeSpanEndPayload(args: RuntimeSpanEndArgs, captureIo: boolean) {
  return {
    level: args.level ?? ("DEFAULT" as RuntimeSpanLevel),
    output: captureIo ? args.output : undefined,
    metadata: { status: args.status, ...args.metadata },
  };
}

/**
 * Open a runtime span under the run trace (#406). No-op closer when Langfuse
 * keys are absent (mirrors `startToolSpan`). The defensive trace upsert is keyed
 * on id so it merges rather than clobbers the run trace the boss generation
 * already created. Every SDK call is swallowed.
 */
export function startRuntimeSpan(input: RuntimeSpanInput): RuntimeSpanCloser {
  const client = getClient();
  if (!client) {
    return {
      end() {
        /* no-op when keys missing */
      },
    };
  }
  const captureIo = shouldCaptureIo();
  let span: ReturnType<Langfuse["span"]> | null = null;
  try {
    client.trace({ id: input.runId });
    span = client.span(buildRuntimeSpanPayload(input, captureIo));
  } catch (err) {
    console.warn("[langfuse] runtime span start failed:", toMessage(err));
  }
  return {
    end(args) {
      try {
        span?.end(buildRuntimeSpanEndPayload(args, captureIo));
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
  const client = getClient();
  if (!client) return;
  try {
    await client.flushAsync();
  } catch (err) {
    console.warn("[langfuse] flush failed:", toMessage(err));
  }
}

export async function shutdownLangfuse(): Promise<void> {
  const client = getClient();
  if (!client) return;
  try {
    await client.shutdownAsync();
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
const CALL_SHAPE: Record<CallKind, string> = {
  llm: "llm",
  embedding: "embedding",
  web_search: "web_search",
  transcription: "transcription",
  tool_api: "tool_api",
  // A briefing call is an LLM generation; `briefing` is only a cost bucket.
  briefing: "llm",
};

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
 * An ad-hoc trace (no run) holds exactly one generation, so its root *is* the
 * call — we mirror the generation I/O up to it. Run traces hold many
 * generations; mirroring any single call's I/O to the root would misrepresent
 * the run.
 */
export function isAdhocTrace(meta: MeteredMeta): boolean {
  return !meta.runId;
}

/** Payload for the parent `client.trace()` upsert. Pure, for testability. */
export function buildTracePayload(args: { meta: MeteredMeta; captureIo: boolean }) {
  const { meta, captureIo } = args;
  return {
    id: resolveTraceId(meta),
    name: resolveTraceName(meta),
    userId: meta.userId,
    // Only group under a Sessions-view entry when the caller supplied a real
    // session id (chat passes `threadId`). Falling back to `runId` would mint a
    // one-trace "session" per background/job run that duplicates the trace and
    // pollutes the Sessions view — Langfuse sessions are for grouping *multiple*
    // traces under a real product session (#226 review).
    sessionId: meta.sessionId,
    // Promote role/kind to filterable trace tags (#226) — they otherwise only
    // live in generation metadata, which the Traces filter can't slice by.
    tags: traceTags(meta),
    input: captureIo && isAdhocTrace(meta) ? meta.input : undefined,
  };
}

/** Payload for `client.generation()`. Pure, for testability. */
export function buildGenerationPayload(args: {
  meta: MeteredMeta;
  startedAt: Date;
  captureIo: boolean;
}) {
  const { meta, startedAt, captureIo } = args;
  return {
    traceId: resolveTraceId(meta),
    name: meta.name ?? `${meta.provider}/${meta.model}`,
    model: meta.model,
    modelParameters: stripParams(meta.requestMeta),
    startTime: startedAt,
    input: captureIo ? meta.input : undefined,
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
  usage?: CallUsage;
  costUsd: number;
  output?: unknown;
  responseMeta?: Record<string, unknown>;
  servedModel?: string;
  captureIo: boolean;
}) {
  const { meta, usage, costUsd, output, responseMeta, servedModel, captureIo } = args;
  // The span opened with the requested model; if the call actually resolved to
  // a different (registry-known) model via fallback, restamp the generation so
  // per-model cost/latency attributes correctly, and keep the requested id in
  // metadata for fallback debugging (#216).
  const servedDiverged = servedModel != null && servedModel !== meta.model;
  return {
    model: servedDiverged ? servedModel : undefined,
    usage: usage
      ? {
          input: usage.inputTokens,
          output: usage.outputTokens,
          total: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
          unit: "TOKENS" as const,
        }
      : undefined,
    usageDetails: usage
      ? {
          input: usage.inputTokens ?? 0,
          output: usage.outputTokens ?? 0,
          cached: usage.cachedInputTokens ?? 0,
        }
      : undefined,
    // Cost in USD; Langfuse's `costDetails` accepts arbitrary keys.
    costDetails: { total: costUsd },
    // Full completion only when capture is on; the small response metadata
    // (finish_reason, tool-call count) is always useful.
    output: captureIo ? output : undefined,
    metadata: servedDiverged ? { ...responseMeta, requestedModel: meta.model } : responseMeta,
  };
}

type LangfuseModelParam = string | number | boolean | string[] | null;

function stripParams(
  meta: Record<string, unknown> | undefined,
): { [key: string]: LangfuseModelParam } | undefined {
  if (!meta) return undefined;
  // Drop fields that are too large or not relevant to the trace, and coerce
  // remaining values to the primitive shapes Langfuse accepts.
  const skip = new Set(["prompt", "messages", "system"]);
  const out: { [key: string]: LangfuseModelParam } = {};
  for (const [k, v] of Object.entries(meta)) {
    if (skip.has(k)) continue;
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    } else if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
      out[k] = v as string[];
    }
    // Anything else (objects, mixed arrays) is silently dropped — Langfuse
    // can't render them and including them broke the type contract.
  }
  return out;
}
