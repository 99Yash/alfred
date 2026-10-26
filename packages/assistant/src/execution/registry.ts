import type {
  AgentRunTrigger,
  CancellationFence,
  RunDeferReason,
  WakeCondition,
  WorkflowTrigger,
} from "@alfred/contracts";
import type { TranscriptMessage } from "@alfred/ai";
import type { DbRoot, DbTransaction } from "@alfred/db";
import type { z } from "zod";
import type { DecisionTraceFor, DecisionTraceKind, DecisionTraceOptions } from "./decision-traces";
import type { WorkflowClosure } from "./terminal-closure";

type MaybePromise<T> = T | Promise<T>;

/** An outbound effect committed with the step and fired later by the dispatcher. */
export interface StagedAction {
  kind: string;
  payload: unknown;
  /**
   * Defaults to `${runId}:${stepId}:${attempt}:${kind}`; set it when a step stages two of one kind.
   */
  idempotencyKey?: string;
}

/**
 * What a step returns. `blocked` ends the run on a readiness failure the user must fix;
 * `interrupt` parks it until the wake condition fires.
 * `N` is the workflow's step names; it defaults to `string`.
 */
export type StepResult<S, N extends string = string> =
  | { kind: "next"; state: S; nextStep: N; transcript?: TranscriptMessage[] }
  | {
      kind: "done";
      state: S;
      output?: unknown;
      /** One safe sentence for the run's history row (#561). */
      summary?: string;
      transcript?: TranscriptMessage[];
    }
  | { kind: "blocked"; state: S; output: unknown; transcript?: TranscriptMessage[] }
  | {
      kind: "defer";
      state: S;
      retryAt: Date;
      output?: unknown;
      /** Defaults to `retry_scheduled`. */
      reason?: RunDeferReason;
      transcript?: TranscriptMessage[];
    }
  | { kind: "interrupt"; state: S; wake: WakeCondition; transcript?: TranscriptMessage[] };

/** A step changes the run only through its return value. */
export interface StepContext<S> {
  runId: string;
  userId: string;
  /** Stable per attempt; forward it as the idempotency key of model and tool calls. */
  idempotencyKey: string;
  attempt: number;
  /**
   * The fence this step started under (#559b). Forward it untouched; dispatch refuses effects after
   * a cancel.
   */
  fence: CancellationFence;
  state: S;
  transcript: TranscriptMessage[];
  /**
   * Commit an outbound effect with this step's result.
   * A re-run is a no-op because `idempotencyKey` is unique on `pending_actions`.
   */
  stageAction(action: StagedAction): void;
  /**
   * Best-effort progress frame to the user's realtime channel (ADR-0005).
   * Never rejects: a publish fault goes to the process log and the frame is lost.
   * Strips poison and caps the text, so any string is safe to pass. Not a durable record.
   */
  log(message: string): Promise<void>;
  /**
   * Write a decision record to `agent_decision_traces` with this step's commit.
   * `decisionKey` separates decisions of one kind; a duplicate kind and key fails the step.
   * Dropped if the step throws.
   */
  trace<K extends DecisionTraceKind>(
    kind: K,
    record: DecisionTraceFor<K>,
    options?: DecisionTraceOptions,
  ): void;
}

export interface Step<S, N extends string = string> {
  /** Must stay stable across deploys. */
  id: N;
  /**
   * Heartbeat silence before a reclaim, in ms (ADR-0070 §1.4). Defaults to `STALE_RUN_LEASE_MS`.
   * Raise it for a long model call: a reclaim bumps `attempt`, so the model is called again at full
   * price.
   * The cost is slower recovery from a dead worker.
   */
  staleAfterMs?: number;
  run(ctx: StepContext<S>): Promise<StepResult<S, N>>;
}

/** What the three start hooks receive. `createRun` builds it one time per run. */
export interface WorkflowInput<M = unknown, I = unknown> {
  userId: string;
  trigger: AgentRunTrigger;
  brief?: string | undefined;
  /** The `metadataSchema` output when the workflow declares one; else the caller's object. */
  metadata: M;
  /** The `inputSchema` output when the workflow declares one; else the caller's value. */
  input: I;
}

export type AgentDbExecutor = DbRoot | DbTransaction;

interface WorkflowInitContext {
  db: AgentDbExecutor;
}

/**
 * A registered workflow definition. `steps` is keyed by `N`, so `initialStep` and every `nextStep`
 * are type-checked.
 */
interface WorkflowDefinition<S, N extends string, M, I> {
  /** Stable across deploys; a resumed run looks the workflow up by it. */
  slug: string;
  /** Registered only so existing runs can finish; it cannot start new runs and is not seeded. */
  resumeOnly?: boolean | undefined;
  name: string;
  description?: string;
  /** Seeded into `workflows.trigger` for built-ins (ADR-0027). */
  trigger: WorkflowTrigger;
  /** An empty array means no limit beyond the user's connected integrations. */
  allowedIntegrations?: string[];
  /** Throw to refuse the run. */
  initialState(input: WorkflowInput<M, I>): S;
  initialTranscript?(
    input: WorkflowInput<M, I>,
    context?: WorkflowInitContext,
  ): MaybePromise<TranscriptMessage[]>;
  initialStep: N;
  steps: { [K in N]: Step<S, N> & { id: K } };
  /** Validates and migrates persisted state before terminal hooks. */
  stateSchema?: z.ZodType<S>;
  /**
   * What the client is owed when the run ends outside a step body (backstop, unresolved step, or
   * cancel).
   * Chat-turn needs it or the streaming bubble hangs. Handle `failed` and `cancelled` apart:
   * a cancel must not show a retry. Make it idempotent; a throw is logged and swallowed.
   */
  closure: WorkflowClosure<S>;
  /**
   * At most one live run per (user, key). Failed and cancelled runs do not count,
   * so an outage is not a permanent lockout. The workflow owns the key, not the caller.
   */
  dedupKey?(input: WorkflowInput<M, I>): string | null;
}

/**
 * `createRun` parses the caller's `metadata` and `input` one time, before any hook runs, and a
 * failed parse inserts no run. A schema is required as soon as the hooks name a type for its value.
 */
type WorkflowSchemas<M, I> = ([unknown] extends [M]
  ? { metadataSchema?: z.ZodType<M> }
  : { metadataSchema: z.ZodType<M> }) &
  ([unknown] extends [I] ? { inputSchema?: z.ZodType<I> } : { inputSchema: z.ZodType<I> });

export type Workflow<
  S = unknown,
  N extends string = string,
  M = unknown,
  I = unknown,
> = WorkflowDefinition<S, N, M, I> & WorkflowSchemas<M, I>;

/** Built-ins register at server boot. */
const registry = new Map<string, Workflow<unknown>>();

export function registerRecipe<S, N extends string, M, I>(workflow: Workflow<S, N, M, I>): void {
  if (registry.has(workflow.slug)) {
    throw new Error(`[agent] workflow already registered: ${workflow.slug}`);
  }

  registry.set(workflow.slug, workflow);
}

export function getWorkflow(slug: string): Workflow<unknown> | undefined {
  return registry.get(slug);
}

export function listWorkflows(): Workflow<unknown>[] {
  return [...registry.values()];
}

export function isInternalWorkflowSlug(slug: string): boolean {
  return slug.startsWith("__");
}

export function listPublicWorkflows(): Workflow<unknown>[] {
  return listWorkflows().filter(
    (workflow) => !isInternalWorkflowSlug(workflow.slug) && !workflow.resumeOnly,
  );
}

export function listResumeOnlyWorkflows(): Workflow<unknown>[] {
  return listWorkflows().filter((workflow) => workflow.resumeOnly);
}

export function _resetRegistryForTests(): void {
  registry.clear();
}
