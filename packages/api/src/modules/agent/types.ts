import type { AgentTranscriptMessage } from "@alfred/contracts";
import type { db } from "@alfred/db";
import type { DecisionTraceFor, DecisionTraceKind, DecisionTraceOptions } from "./decision-traces";
import {
  RUN_STATUSES,
  isTerminalStatus,
  type AgentRunTrigger,
  type ApprovalKind,
  type RunStatus,
  type WakeCondition,
  type WorkflowTrigger,
} from "@alfred/contracts";
import type { z } from "zod";

export type MaybePromise<T> = T | Promise<T>;

/**
 * Run lifecycle states (mirrors the `status` column on `agent_runs`).
 *
 *   pending    enqueued, never picked up
 *   runnable   ready for the worker to claim
 *   running    a worker holds the lease
 *   waiting    parked on a `wakeCondition`
 *   completed  terminal success
 *   failed     terminal error
 *   cancelled  user-initiated stop
 */
export { RUN_STATUSES, isTerminalStatus };
export type { ApprovalKind, RunStatus, WakeCondition };

/** Outbound effect staged inside a step's commit — fired by the dispatcher worker (m7+). */
export interface StagedAction {
  /** Provider/tool key — `gmail.send`, `slack.post`, etc. */
  kind: string;
  payload: unknown;
  /**
   * Idempotency key passed to the provider. Defaults to
   * `${runId}:${stepId}:${attempt}:${kind}` if not specified — that's
   * the right answer for steps that stage exactly one action of a kind.
   */
  idempotencyKey?: string;
}

/**
 * What a step returns when it finishes:
 *  - `next` advances to another step in the same workflow
 *  - `done` completes the run with an optional output
 *  - `interrupt` parks the run until the wake condition fires
 */
export type StepResult<S> =
  | { kind: "next"; state: S; nextStep: string; transcript?: AgentTranscriptMessage[] }
  | { kind: "done"; state: S; output?: unknown; transcript?: AgentTranscriptMessage[] }
  | { kind: "interrupt"; state: S; wake: WakeCondition; transcript?: AgentTranscriptMessage[] };

/** Context handed to a step body. Steps mutate via the return value, not by reaching out. */
export interface StepContext<S> {
  runId: string;
  userId: string;
  /** Stable per-attempt key; safe to forward to LLM/tool calls as their idempotency-key. */
  idempotencyKey: string;
  attempt: number;
  state: S;
  transcript: AgentTranscriptMessage[];
  /**
   * Stage an outbound effect committed atomically with this step's result.
   * Re-running the same attempt is a no-op because the (kind,
   * idempotencyKey) pair is unique on `pending_actions`. The action id
   * isn't returned here — callers correlate via `idempotencyKey`.
   */
  stageAction(action: StagedAction): void;
  /** Emit a progress event (durable via the outbox) without finishing the step. */
  log(message: string): Promise<void>;
  /**
   * Persist a durable, structured decision record (#219 PR-A) into
   * `agent_decision_traces`, committed atomically with this step's result.
   * Generic over the {@link DecisionTraceRegistry}, so the `record` shape must
   * match the declared `kind` — drift fails the build. `decisionKey` separates
   * multiple decisions of the same kind in one step; duplicate kind/key pairs
   * fail the step instead of being silently dropped. Executor-collected traces
   * persist only on a successful commit (`next`/`done`/`interrupt`) and are
   * dropped if the step throws. A domain store may additionally write the same
   * keyed trace inside its own transaction when row+trace atomicity matters; the
   * executor insert is idempotent for that slot.
   * Unlike {@link log}, this is queryable substrate, not a transient progress
   * event.
   */
  trace<K extends DecisionTraceKind>(
    kind: K,
    record: DecisionTraceFor<K>,
    options?: DecisionTraceOptions,
  ): void;
}

export interface Step<S> {
  /** Logical step id within the workflow (must be stable across deploys). */
  id: string;
  /**
   * Optional per-step stale-lease window, in ms (ADR-0070 §1.4, Lever A). A
   * `running` row whose heartbeat has been silent longer than this is presumed
   * dead and reclaimed (executor `leaseRun` + the resume sweep). Defaults to
   * `STALE_RUN_LEASE_MS` (60s) when unset.
   *
   * Raise it for a step whose body is a single long model call (a multi-minute
   * boss turn). The default window is tight enough that a brief heartbeat lapse
   * can reclaim a *live* turn, and because the LLM idempotency key includes
   * `attempt` (bumped on reclaim), the reclaimer re-calls the model — a
   * duplicate, full-price call on the slowest turns. Heartbeats (every 10s) keep
   * a healthy step fresh regardless, so a wider window only bites on *sustained*
   * heartbeat loss; the tradeoff is that a genuinely dead worker on such a step
   * recovers after this longer window instead of 60s.
   */
  staleAfterMs?: number;
  run(ctx: StepContext<S>): Promise<StepResult<S>>;
}

/** Context handed to {@link Workflow.onTerminalFailure}. */
export interface TerminalFailureContext<S> {
  runId: string;
  userId: string;
  /** The run's last-committed state (validated against `stateSchema` if present). */
  state: S;
  /** Sanitized, user-safe failure message (the synthetic backstop string, etc.). */
  error: string;
}

export interface WorkflowInput {
  /** User who owns this run; needed by DB-aware run initializers. */
  userId: string;
  /** First-class reason this run was created. */
  trigger: AgentRunTrigger;
  /** Optional human-readable brief for the run (free text). */
  brief?: string;
  /** Workflow-defined initial input passed to `initialState`. */
  input?: unknown;
  /** Free-form metadata persisted on the run row. */
  metadata?: Record<string, unknown>;
}

type AgentDbRoot = ReturnType<typeof db>;
type AgentDbTransaction = Parameters<Parameters<AgentDbRoot["transaction"]>[0]>[0];

export type AgentDbExecutor = AgentDbRoot | AgentDbTransaction;

export interface WorkflowInitContext {
  db: AgentDbExecutor;
}

export interface DedupKeyArgs extends WorkflowInput {
  userId: string;
}

export interface Workflow<S = unknown> {
  /** Stable slug; used to look up the workflow when resuming a run after a deploy. */
  slug: string;
  /**
   * Keep the workflow executable only for already-persisted runs. Resume-only
   * workflows remain registered so durable checkpoints survive deploys, but
   * are excluded from catalogs and built-in seeding and cannot start new runs.
   */
  resumeOnly?: boolean;
  /**
   * Display name shown in the settings / workflows list. Required for
   * built-ins because the seeder writes it into the `workflows.name`
   * column at deploy time.
   */
  name: string;
  description?: string;
  /**
   * Trigger declaration for built-ins (ADR-0027). Seeded into the
   * `workflows.trigger` column per user; the cron dispatcher reads it
   * back via the partial index. User-authored workflows manage their
   * trigger through the CRUD API instead.
   */
  trigger: WorkflowTrigger;
  /**
   * Optional explicit allowlist for `load_integration` during agent
   * runs (ADR-0026). Mirrored onto the `workflows.allowed_integrations`
   * column; empty array = unrestricted (subject to the user's connected
   * integrations).
   */
  allowedIntegrations?: string[];
  /** Build the run's initial state from the caller's input. Throw to refuse the run. */
  initialState(input: WorkflowInput): S;
  /** Optional initial transcript persisted beside `state`. Omitted by non-agent builtins. */
  initialTranscript?(
    input: WorkflowInput,
    context?: WorkflowInitContext,
  ): MaybePromise<AgentTranscriptMessage[]>;
  /** Step the executor enters first. */
  initialStep: string;
  steps: Record<string, Step<S>>;
  /** Optional zod schema validating `initialState` shape. Run on every load to catch state drift after deploys. */
  stateSchema?: z.ZodType<S>;
  /**
   * Optional hook invoked when a run is terminally failed *outside* the step
   * body — the non-progressing-step backstop (ADR-0070 §1.4) or a post-deploy
   * step-resolution failure. Step-body faults already finalize themselves
   * before rethrowing, but those external paths never enter the step, so a
   * workflow that owns client-facing closure (chat-turn writes a failed
   * assistant row + emits `chat.message completed`) would otherwise strand the
   * UI. Best-effort: the run is already terminal in the DB; a throw here is
   * logged and swallowed.
   */
  onTerminalFailure?(ctx: TerminalFailureContext<S>): Promise<void>;
  /**
   * Optional singleton-key derivation for workflows that may run at most
   * once per (user, key) at a time. When defined and non-null, the
   * partial unique index on `agent_runs.(user_id, workflow_slug, dedup_key)`
   * makes a second `createRun` for the same triple fail with a unique
   * violation while a prior run is still active. Failed/cancelled rows
   * are excluded so a transient outage isn't a permanent lockout.
   * Caller-supplied input is intentionally NOT in scope here — the
   * workflow owns dedup, not the caller.
   */
  dedupKey?(args: DedupKeyArgs): string | null;
}
