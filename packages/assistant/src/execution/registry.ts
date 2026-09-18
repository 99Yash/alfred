import type {
  AgentRunTrigger,
  AgentTranscriptMessage,
  CancellationFence,
  WakeCondition,
  WorkflowTrigger,
} from "@alfred/contracts";
import type { DbRoot, DbTransaction } from "@alfred/db";
import type { z } from "zod";
import type { DecisionTraceFor, DecisionTraceKind, DecisionTraceOptions } from "./decision-traces";
import type { WorkflowClosure } from "./terminal-closure";

type MaybePromise<T> = T | Promise<T>;

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

/** The closed set of reasons a step may defer a run to a later attempt. */
export type RunDeferReason = "provider_unhealthy" | "retry_scheduled";

/**
 * What a step returns when it finishes:
 *  - `next` advances to another step in the same workflow
 *  - `done` completes the run with an optional output
 *  - `defer` parks until a bounded retry instant
 *  - `blocked` terminates on an actionable readiness failure
 *  - `interrupt` parks the run until the wake condition fires
 *
 * The step-name union a workflow owns is derived from its `steps` keys (the
 * `StepName = keyof typeof steps` pattern in `email-triage`). Defaults to
 * `string` for workflows and type-erased helpers that have not adopted it yet,
 * so the generic is additive: only a workflow that opts in loses the ability to
 * name a step that does not exist.
 */
export type StepResult<S, N extends string = string> =
  | { kind: "next"; state: S; nextStep: N; transcript?: AgentTranscriptMessage[] }
  | {
      kind: "done";
      state: S;
      output?: unknown;
      /**
       * One safe sentence for the run's history row (#561). The workflow that
       * produced the output is the only code that knows which of its keys is
       * the headline, so it names the sentence here rather than leaving the
       * outcome derivation to guess at `output` keys.
       */
      summary?: string;
      transcript?: AgentTranscriptMessage[];
    }
  | { kind: "blocked"; state: S; output: unknown; transcript?: AgentTranscriptMessage[] }
  | {
      kind: "defer";
      state: S;
      retryAt: Date;
      output?: unknown;
      /** Why the run stepped aside; the history row shows it. Defaults to `retry_scheduled`. */
      reason?: RunDeferReason;
      transcript?: AgentTranscriptMessage[];
    }
  | { kind: "interrupt"; state: S; wake: WakeCondition; transcript?: AgentTranscriptMessage[] };

/** Context handed to a step body. Steps mutate via the return value, not by reaching out. */
export interface StepContext<S> {
  runId: string;
  userId: string;
  /** Stable per-attempt key; safe to forward to LLM/tool calls as their idempotency-key. */
  idempotencyKey: string;
  attempt: number;
  /**
   * The cancellation fence this step started under (#559b). The tool-runtime
   * dispatch gate re-reads the run's fence before each effect and refuses any
   * dispatch whose current generation has moved past this value. Bounded
   * contract from `@alfred/contracts`; the execution module builds it from the
   * leased `agent_runs.cancellation_generation` and workflows forward it into
   * their `ToolCallRun` untouched.
   */
  fence: CancellationFence;
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

export interface Step<S, N extends string = string> {
  /**
   * Logical step id within the workflow (must be stable across deploys). Typed
   * to the workflow's own step-name union so it matches its `steps` key.
   */
  id: N;
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
  run(ctx: StepContext<S>): Promise<StepResult<S, N>>;
}

export interface WorkflowInput {
  /** User who owns this run; needed by DB-aware run initializers. */
  userId: string;
  /** First-class reason this run was created. */
  trigger: AgentRunTrigger;
  /** Optional human-readable brief for the run (free text). */
  brief?: string | undefined;
  /** Workflow-defined initial input passed to `initialState`. */
  input?: unknown | undefined;
  /** Free-form metadata persisted on the run row. */
  metadata?: Record<string, unknown> | undefined;
}

export type AgentDbExecutor = DbRoot | DbTransaction;

interface WorkflowInitContext {
  db: AgentDbExecutor;
}

interface DedupKeyArgs extends WorkflowInput {
  userId: string;
}

/**
 * A registered workflow definition: the durable-execution contract a recipe
 * implements. The registry below stores these type-erased to `Workflow<unknown>`;
 * that Map is why this shape and its `Step`/`StepResult`/`StepContext` pieces,
 * `WorkflowInput`, `StagedAction`, and `AgentDbExecutor` live in this file — a
 * definition and the shape it must satisfy co-change. The terminal-closure
 * contract (`WorkflowClosure`, `TerminalOutcome`) lives with its driver in
 * `./terminal-closure`.
 *
 * Hand-written, not derived: there is no table row or wire schema behind these;
 * this file is the source of truth for the runtime contract. A recipe's topology
 * is stated once through the `steps` mapped type keyed by the workflow's own `N`,
 * so `initialStep` and every `nextStep` are checked against it.
 */
export interface Workflow<S = unknown, N extends string = string> {
  /** Stable slug; used to look up the workflow when resuming a run after a deploy. */
  slug: string;
  /**
   * Keep the workflow executable only for already-persisted runs. Resume-only
   * workflows remain registered so durable checkpoints survive deploys, but
   * are excluded from catalogs and built-in seeding and cannot start new runs.
   */
  resumeOnly?: boolean | undefined;
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
   * Optional integration allowlist for exact tool discovery, loading, and
   * dispatch. Mirrored onto the `workflows.allowed_integrations`
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
  /**
   * Step the executor enters first. `N` defaults to `string`; a workflow that
   * derives `N` from its `steps` keys makes an unknown entry step a type error.
   */
  initialStep: N;
  /**
   * The workflow's topology, keyed by step name. When `N` is derived from these
   * keys, every `nextStep` in the step bodies and `initialStep` are checked
   * against them, and each entry's `id` must equal its key, so the topology is
   * stated once and cannot drift.
   */
  steps: { [K in N]: Step<S, N> & { id: K } };
  /** Optional parser used to validate and migrate persisted state before terminal hooks. */
  stateSchema?: z.ZodType<S>;
  /**
   * Required declaration of whether a run going terminal *outside* its step
   * body owes client-facing closure. `{ kind: "none" }` is an explicit,
   * greppable answer; workflows that do own client state provide the exhaustive
   * hook instead.
   * Chat-turn writes the durable assistant row and emits `chat.message
   * completed`; without it the streaming bubble hangs forever.
   *
   * Three transitions reach it, under two `ctx.outcome`s:
   *  - `"failed"` — the non-progressing-step backstop (ADR-0070 §1.4), or a
   *    post-deploy step-resolution failure.
   *  - `"cancelled"` — the approvals `cancel_run` decision, or `cancelRun`
   *    directly. Since the #530 commit guard, a cancel landing mid-step rolls the
   *    in-flight commit back, so nothing else will close the turn.
   *
   * **`switch` on `ctx.outcome` and handle both**, with a `never` assertion in the
   * default. They are not interchangeable: a cancel is something the user chose,
   * so rendering a failure UI with a "retry" affordance both lies and offers to
   * re-run a turn they just ended. The union exists so that omission is a compile
   * error rather than the regression it was (#530/#531 review, finding D2).
   *
   * Best-effort: the run is already terminal in the DB, so a throw here is logged
   * and swallowed — it must never resurrect or re-fail the run. Make it
   * idempotent; a step-body finalize may already have landed.
   */
  closure: WorkflowClosure<S>;
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

/**
 * In-memory workflow registry. The executor looks up `(workflowSlug)` here
 * when claiming a run; built-ins register at server boot. Decoupling
 * registration from execution lets us add user-authored workflows later
 * without forking the runtime.
 */
const registry = new Map<string, Workflow<unknown>>();

export function registerRecipe<S>(workflow: Workflow<S>): void {
  if (registry.has(workflow.slug)) {
    throw new Error(`[agent] workflow already registered: ${workflow.slug}`);
  }

  // SAFETY: the registry's storage shape is the type-erased Workflow<unknown>;
  // every registered definition is stored under this one erase.
  registry.set(workflow.slug, workflow as Workflow<unknown>);
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

/** Test-only: drop everything. Production code never calls this. */
export function _resetRegistryForTests(): void {
  registry.clear();
}
