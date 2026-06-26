import type { AttributionKind } from "@alfred/contracts";

/** What `metered()` writes to `api_call_log`. Extracted post-hoc from the SDK result. */
export interface CallUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

/**
 * Discriminator for `api_call_log.kind`. The canonical union lives in
 * `@alfred/contracts` (`AttributionKind`) so the web cost-rollup UI can
 * read it without pulling Node-only deps. `CallKind` is preserved here as
 * a source-compatible alias for the wrapper-API callers.
 */
export type CallKind = AttributionKind;

/**
 * Logical caller of a metered LLM call. Surfaces on
 * `api_call_log.request_meta.role` so cost rollups can split a run's
 * spend between agent surfaces (boss vs sub-agent vs compactor) without
 * adding a column. Wired in Phase 7 (ADR-0035) for the boss workflow's
 * three roles: `'boss'` and `'sub_agent'` on `AlfredAgent.turn()` calls
 * inside `userAuthoredBriefWorkflow`, and `'compactor'` on
 * `compactTranscript`. The remaining roles (`'triage'`, `'briefing'`,
 * `'cold_start'`, `'memory_extraction'`) are typed for forward-compat
 * and get plumbed when those call sites are revisited.
 */
export type CallRole =
  | "compactor"
  | "boss"
  | "sub_agent"
  | "triage"
  | "briefing"
  | "cold_start"
  | "memory_extraction";

/**
 * Caller-supplied attribution and free-form metadata persisted with each
 * call row. Attribution columns are nullable — ad-hoc test calls and
 * cold-start research run outside an agent and still want metering.
 */
export interface CallAttribution {
  userId?: string;
  runId?: string;
  stepId?: string;
  attempt?: number;
  messageId?: string;
  /**
   * Override `api_call_log.kind`. The `meteredGenerateText` /
   * `meteredGenerateObject` wrappers default to `'llm'`; pass
   * `'web_search'` here when routing a Google Gemini (or future
   * search-shaped) model so cost rollups bucket it correctly per
   * ADR-0015. `meteredEmbed` always uses `'embedding'` regardless.
   */
  kind?: CallKind;
  /**
   * Logical caller within the agent runtime. Forwarded to
   * `api_call_log.request_meta.role` so a single run's spend can be
   * split between boss / sub-agent / compactor without adding a column.
   * Optional — calls outside an agent (ad-hoc tests, cold-start) may
   * omit it.
   */
  role?: CallRole;
  /**
   * Langfuse session id (#226). Groups multiple traces that belong to one
   * real conversation/thread into a single Sessions-view entry. Chat passes
   * the `threadId` so a multi-turn conversation (each turn its own run/trace)
   * collapses into one session. Omit it for background/job runs: a Langfuse
   * session is for grouping *multiple* traces, and falling back to `runId`
   * would mint a one-trace "session" per run that just duplicates the trace
   * and pollutes the Sessions view (#226 review). Trace-only — never persisted
   * to `api_call_log`.
   */
  sessionId?: string;
}

export interface MeteredMeta extends CallAttribution {
  kind: CallKind;
  provider: string;
  model: string;
  /**
   * Stable per-call key. Forwarded to the provider's idempotency-key header
   * when supported; also tags the Langfuse span. Defaults to a generated
   * UUID when omitted, but callers inside an agent step should pass
   * `${runId}:${stepId}:${attempt}` to make replays grep-able.
   */
  idempotencyKey?: string;
  /** Trimmed model params surfaced to the log row's `request_meta`. Avoid full prompts here. */
  requestMeta?: Record<string, unknown>;
  /** Human-readable name surfaced in Langfuse — defaults to `${provider}/${model}`. */
  name?: string;
  /**
   * Full request input (prompt / messages / system) for the Langfuse span.
   * Only sent when `LANGFUSE_CAPTURE_IO=true`; never persisted to
   * `api_call_log` (writeLogRow ignores it). Keeps the heavy prompt text on
   * the detachable observability sidecar, out of the cost ledger.
   */
  input?: unknown;
}

/** What the runtime extracts from a successful SDK result for billing + log shape. */
export interface MeteredResult {
  usage?: CallUsage;
  /** Surfaced to `response_meta` (finish_reason, model id echoed back, tool_calls count, etc.). */
  responseMeta?: Record<string, unknown>;
  /**
   * Full completion text/object for the Langfuse span. Only sent when
   * `LANGFUSE_CAPTURE_IO=true`; never persisted to `api_call_log`.
   */
  output?: unknown;
  /**
   * Model id the provider reported actually serving the call
   * (`result.response.modelId`). `MeteredMeta.provider/model` are resolved
   * from the model object *before* the call, so when a `withFallback`
   * cascade switches providers mid-call the meta misattributes — `metered()`
   * re-resolves provider + price from this id (via `MODEL_REGISTRY`) when it
   * differs. Registry-gated: an unrecognized served id (e.g. a provider's
   * dated alias of the same model) leaves the pre-call meta untouched.
   */
  served?: { model: string };
}

export type ResultExtractor<T> = (value: T) => MeteredResult;
