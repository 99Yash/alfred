import {
  ensureDefaultActionPolicyForUser,
  startPolicyBustSubscriber,
  stopPolicyBustSubscriber,
} from "@alfred/assistant/action-policies";
import {
  scheduleRepeatableWorkflowsJobs,
  seedBuiltinWorkflowsForAllUsers,
  seedBuiltinWorkflowsForUser,
  closeWorkflowsQueue,
  startWorkflowsWorker,
  stopWorkflowsWorker,
} from "@alfred/assistant/automation";
import {
  closeBriefingQueue,
  scheduleRepeatableBriefingJobs,
  startBriefingWorker,
  stopBriefingWorker,
} from "@alfred/assistant/briefings";
import {
  closeIngestionQueue,
  scheduleRepeatableIngestionJobs,
  startIngestionWorker,
  stopIngestionWorker,
} from "@alfred/assistant/connections/ingestion";
import {
  closeChatMemoryQueue,
  closeConversationCompactionQueue,
  startChatMemoryWorker,
  startConversationCompactionWorker,
  stopChatMemoryWorker,
  stopConversationCompactionWorker,
} from "@alfred/assistant/conversations";
import {
  closeAgentQueue,
  closeSubAgentJoinWakeQueue,
  startAgentWorker,
  startApprovalExpiryWorker,
  startApprovalNotificationWorker,
  startSubAgentJoinWakeWorker,
  stopAgentWorker,
  stopApprovalExpiryWorker,
  stopApprovalNotificationWorker,
  stopSubAgentJoinWakeWorker,
  verifyMeteringModels,
} from "@alfred/assistant/execution";
import {
  closeMemoryQueue,
  scheduleRepeatableMemoryJobs,
  startMemoryWorker,
  stopMemoryWorker,
} from "@alfred/assistant/knowledge";
import {
  closeEventBridge,
  closeReplicachePokeBridge,
  initEventBridge,
  initReplicachePokeBridge,
} from "@alfred/assistant/realtime";
import {
  closeApprovalExpiryQueue,
  closeApprovalNotificationQueue,
} from "@alfred/assistant/tool-runtime";
import { reconcileInflightInvocations } from "@alfred/assistant/tool-runtime/mcp";
import { toMessage } from "@alfred/contracts";
import { closeConnections, warmPool } from "@alfred/db";
import { closeRedis } from "@alfred/db/redis";
import { registerRuntimeAdapters, unregisterRuntimeAdapters } from "./adapters/runtime-adapters";

/** Called once per newly created user, after the host installs the hook. */
export type RuntimeUserCreatedHandler = (user: { id: string }) => Promise<void>;

/**
 * The capabilities the host process owns and the runtime cannot import.
 *
 * Every member is here because the assistant package must not reach transport,
 * authentication, or the server process (ADR-0089). The host keeps the values and
 * the registration doors; the runtime keeps the order they are used in.
 */
export interface RuntimeConfig {
  /** Concurrency for the agent worker. The shared pool ceiling derives from it. */
  readonly workerConcurrency: number;
  /**
   * Register built-in workflows and tools, plus the tool-call-round adapter.
   * Runs before any worker can lease a job that names one of them.
   */
  registerRecipes(): void;
  /** Install the per-user seed hook on the host's authentication layer. */
  registerUserCreated(handler: RuntimeUserCreatedHandler): void;
  /** Fail the boot when persisted credentials are not fully sealed (#453). */
  assertCredentialsReady(): Promise<void>;
  /** Flush metering rows and traces, under the host's own time bound. */
  flushObservability(): Promise<void>;
}

/** The one lifecycle object a host process drives. */
export interface AssistantRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Run one teardown step and report whether it finished.
 *
 * It never rethrows: `stop` must attempt every remaining step, so one unrelated
 * failure cannot leave a worker live while the adapters it needs disappear. The
 * boolean is read for exactly one decision — see the ingestion retention rule in
 * `stop`. Exported for `test/runtime/runtime-contract.test.ts`; the manifest does
 * not carry it.
 */
export async function runShutdownStep(label: string, step: () => Promise<void>): Promise<boolean> {
  try {
    await step();
    return true;
  } catch (err) {
    console.error(`Error during shutdown step ${label}:`, toMessage(err));
    return false;
  }
}

/**
 * Build the assistant runtime for one host process.
 *
 * The returned object owns registration order, worker start order, and the reverse
 * teardown order. A host supplies configuration and drives `start`/`stop`; it does
 * not reach the adapters, the queues, or the workers by name.
 */
export function createAssistantRuntime(config: RuntimeConfig): AssistantRuntime {
  return {
    async start(): Promise<void> {
      await warmPool();
      // #453 boot gate, before anything can serve a request or lease a job. A
      // process that starts against a half-converted credential table would throw
      // on every token read AND rewrite plaintext behind the operator's back, so
      // an unfinished backfill must fail the boot instead of degrading quietly.
      // See `docs/runbooks/oauth-credential-vault-rollout.md`.
      await config.assertCredentialsReady();
      // ADR-0035 guard: every agent model must have a populated
      // `model_prices.context_window`. A missing value means the compactor
      // can't size its 60% threshold, so the boss would loop unbounded.
      await verifyMeteringModels();

      // Crash-recovery barrier sweep (ADR-0018): resolve MCP invocations that a
      // prior process left in-flight — abandoned `prepared` rows and idempotent
      // reads clear; genuinely ambiguous writes stay blocked so an identical repeat
      // keeps rejecting until a host-minted successor. Runs once the pool is warm
      // and before any worker can pick up an MCP call.
      await reconcileInflightInvocations();

      await initEventBridge();
      await initReplicachePokeBridge();

      // Register built-ins before any worker can pick up a job that references
      // their workflow or tool names. The host owns this step because the built-in
      // recipes and the dispatch tool-call-round adapter sit above this package.
      config.registerRecipes();
      // Runtime composition installs the agent, conversations, workflow, knowledge,
      // and task system-tool ports after the built-ins exist and before a worker can
      // dispatch its first call. Their disposers run with the other adapters.
      registerRuntimeAdapters();

      config.registerUserCreated(async (user) => {
        await seedBuiltinWorkflowsForUser(user.id);
        await ensureDefaultActionPolicyForUser(user.id);
      });

      await seedBuiltinWorkflowsForAllUsers();
      await startPolicyBustSubscriber();

      // Concurrency is env-tunable (#437). It is also the *only* knob: the shared
      // `pg.Pool` ceiling every one of these workers draws from is derived from the
      // same value (`@alfred/env/pool`), so raising throughput can't silently
      // outrun the pool it runs against.
      await startAgentWorker({ concurrency: config.workerConcurrency });
      await startSubAgentJoinWakeWorker();
      await startIngestionWorker();
      await startMemoryWorker();
      await startChatMemoryWorker();
      await startConversationCompactionWorker();
      await startBriefingWorker();
      await startWorkflowsWorker();
      await startApprovalNotificationWorker();
      await startApprovalExpiryWorker();

      await scheduleRepeatableIngestionJobs();
      await scheduleRepeatableMemoryJobs();
      await scheduleRepeatableBriefingJobs();
      await scheduleRepeatableWorkflowsJobs();
    },

    async stop(): Promise<void> {
      // Preserve the required stop order, but attempt every step. One unrelated
      // worker failure must not leave ingestion live while its adapters disappear.
      await runShutdownStep("agent worker", stopAgentWorker);
      await runShutdownStep("sub-agent join-wake worker", stopSubAgentJoinWakeWorker);
      // The chat-memory debounce worker's fire creates + enqueues an agent run, so
      // it must stop before the agent queue closes — same rationale as join-wake.
      await runShutdownStep("chat-memory worker", stopChatMemoryWorker);
      await runShutdownStep("conversation-compaction worker", stopConversationCompactionWorker);
      await runShutdownStep("agent queue", closeAgentQueue);
      await runShutdownStep("sub-agent join-wake queue", closeSubAgentJoinWakeQueue);
      await runShutdownStep("chat-memory queue", closeChatMemoryQueue);
      await runShutdownStep("conversation-compaction queue", closeConversationCompactionQueue);
      await runShutdownStep("approval-notification worker", stopApprovalNotificationWorker);
      await runShutdownStep("approval-notification queue", closeApprovalNotificationQueue);
      await runShutdownStep("approval-expiry worker", stopApprovalExpiryWorker);
      await runShutdownStep("approval-expiry queue", closeApprovalExpiryQueue);
      const ingestionWorkerStopped = await runShutdownStep("ingestion worker", stopIngestionWorker);
      await runShutdownStep("ingestion queue", closeIngestionQueue);
      await runShutdownStep("memory worker", stopMemoryWorker);
      await runShutdownStep("memory queue", closeMemoryQueue);
      await runShutdownStep("briefing worker", stopBriefingWorker);
      await runShutdownStep("briefing queue", closeBriefingQueue);
      await runShutdownStep("workflows worker", stopWorkflowsWorker);
      await runShutdownStep("workflows queue", closeWorkflowsQueue);
      console.log("Worker shutdown attempted");

      // These adapters serve ingestion jobs. Keep them registered if stopping that
      // worker failed, so an already-leased job cannot observe missing composition.
      if (!ingestionWorkerStopped) {
        console.warn("Ingestion adapters retained because the ingestion worker did not stop");
      }
      unregisterRuntimeAdapters({ ingestionWorkerStopped });

      try {
        // Workers are stopped, so no new metering rows or Langfuse spans will be
        // produced. Flush both before the DB pool and Redis close below: metering
        // writes are fire-and-forget into `api_call_log` and need the pool alive,
        // and Langfuse batches spans on a 15-event / 10s timer — so a short turn's
        // trace is otherwise dropped when a redeploy SIGTERM recycles the process
        // inside that window (the missing follow-up-turn trace). Sentry already
        // flushes on shutdown; this closes the same gap for the LLM observability.
        //
        // The host bounds the wait, because the same bound also covers its crash
        // handler: a stalled network flush must not hold graceful shutdown open
        // until the platform SIGKILLs.
        await config.flushObservability();
        console.log("Observability flushed");
      } catch (err) {
        console.error("Error flushing observability:", toMessage(err));
      }

      try {
        await stopPolicyBustSubscriber();
        await closeEventBridge();
        await closeReplicachePokeBridge();
        await closeRedis();
        console.log("Redis closed");
      } catch (err) {
        console.error("Error closing Redis:", toMessage(err));
      }

      try {
        await closeConnections();
        console.log("DB pool closed");
      } catch (err) {
        console.error("Error closing DB:", toMessage(err));
      }
    },
  };
}
