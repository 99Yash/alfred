import type { WorkflowTrigger } from "@alfred/db/schemas";
import type { z } from "zod";

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
export const RUN_STATUSES = [
  "pending",
  "runnable",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** A run is finished — the worker should never touch it again. */
export function isTerminalStatus(s: RunStatus): boolean {
  return s === "completed" || s === "failed" || s === "cancelled";
}

export type ApprovalKind = "step" | "action_staging";

/**
 * What unfreezes a parked run. The runtime persists this on the run row
 * when a step returns `interrupt`; an external signal (HIL approve,
 * timer expiry, named signal) flips the run back to `runnable`.
 *
 * `approvalKind` is optional because pre-m13 rows in `agent_runs.wake_condition`
 * predate the field — DB-loaded conditions may not carry it. New writers
 * always populate it; readers must treat it as best-effort.
 */
export type WakeCondition =
  | { kind: "hil"; approvalId: string; approvalKind?: ApprovalKind; prompt?: string }
  | { kind: "timer"; wakeAt: string }
  | { kind: "signal"; name: string };

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
  | { kind: "next"; state: S; nextStep: string }
  | { kind: "done"; state: S; output?: unknown }
  | { kind: "interrupt"; state: S; wake: WakeCondition };

/** Context handed to a step body. Steps mutate via the return value, not by reaching out. */
export interface StepContext<S> {
  runId: string;
  userId: string;
  /** Stable per-attempt key; safe to forward to LLM/tool calls as their idempotency-key. */
  idempotencyKey: string;
  attempt: number;
  state: S;
  /**
   * Stage an outbound effect committed atomically with this step's result.
   * Re-running the same attempt is a no-op because the (kind,
   * idempotencyKey) pair is unique on `pending_actions`. The action id
   * isn't returned here — callers correlate via `idempotencyKey`.
   */
  stageAction(action: StagedAction): void;
  /** Emit a progress event (durable via the outbox) without finishing the step. */
  log(message: string): Promise<void>;
}

export interface Step<S> {
  /** Logical step id within the workflow (must be stable across deploys). */
  id: string;
  run(ctx: StepContext<S>): Promise<StepResult<S>>;
}

export interface WorkflowInput {
  /** Optional human-readable brief for the run (free text). */
  brief?: string;
  /** Workflow-defined initial input passed to `initialState`. */
  input?: unknown;
  /** Free-form metadata persisted on the run row. */
  metadata?: Record<string, unknown>;
}

export interface DedupKeyArgs extends WorkflowInput {
  userId: string;
}

export interface Workflow<S = unknown> {
  /** Stable slug; used to look up the workflow when resuming a run after a deploy. */
  slug: string;
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
  /** Step the executor enters first. */
  initialStep: string;
  steps: Record<string, Step<S>>;
  /** Optional zod schema validating `initialState` shape. Run on every load to catch state drift after deploys. */
  stateSchema?: z.ZodType<S>;
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
