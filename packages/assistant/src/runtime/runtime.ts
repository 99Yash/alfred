import {
  ensureDefaultActionPolicyForUser,
  startPolicyBustSubscriber,
  stopPolicyBustSubscriber,
} from "@alfred/assistant/action-policies";
import {
  getWorkflowsQueue,
  scheduleRepeatableWorkflowsJobs,
  seedBuiltinWorkflowsForAllUsers,
  seedBuiltinWorkflowsForUser,
  closeWorkflowsQueue,
  startWorkflowsWorker,
  stopWorkflowsWorker,
} from "@alfred/assistant/automation";
import {
  closeBriefingQueue,
  getBriefingQueue,
  scheduleRepeatableBriefingJobs,
  startBriefingWorker,
  stopBriefingWorker,
} from "@alfred/assistant/briefings";
import {
  closeIngestionQueue,
  getIngestionQueue,
  scheduleRepeatableIngestionJobs,
  startIngestionWorker,
  startReceiptPayloadReaper,
  stopIngestionWorker,
  stopReceiptPayloadReaper,
} from "@alfred/assistant/connections/ingestion";
import {
  startDocumentAskReconciler,
  stopDocumentAskReconciler,
} from "@alfred/assistant/connections";
import {
  startMcpConnectionRecovery,
  stopMcpConnectionRecovery,
} from "@alfred/assistant/connections/mcp";
import {
  closeChatMemoryQueue,
  closeConversationCompactionQueue,
  startChatMemoryWorker,
  startConversationCompactionWorker,
  stopChatMemoryWorker,
  stopConversationCompactionWorker,
} from "@alfred/assistant/chat";
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
import { getMemoryQueue } from "@alfred/assistant/knowledge/queue";
import { scheduledJobsEnabled } from "@alfred/env/server";
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

/** What the host owns and the assistant package must not import: transport, auth, the server (ADR-0089). */
export interface RuntimeConfig {
  /** Agent worker concurrency. The shared pool ceiling derives from it. */
  readonly workerConcurrency: number;
  /** Register built-in workflows, tools, and the tool-call-round adapter before any worker starts. */
  registerRecipes(): void;
  registerUserCreated(handler: RuntimeUserCreatedHandler): void;
  /** Fail the boot when persisted credentials are not fully sealed (#453). */
  assertCredentialsReady(): Promise<void>;
  /** Flush metering and traces. The host bounds the wait. */
  flushObservability(): Promise<void>;
}

/** The one lifecycle object a host process drives. */
export interface AssistantRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Run one teardown step and return whether it finished. Never rethrows, so `stop` tries every step. */
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
 * Delete every persisted repeatable job scheduler and return the count.
 * BullMQ keeps schedulers in Redis across restarts, so skipping
 * `scheduleRepeatable*` alone still fires a prior run's crons.
 * Reads the live set, so a scheduler added later is covered too.
 */
async function clearPersistedJobSchedulers(): Promise<number> {
  const queues = [getIngestionQueue(), getMemoryQueue(), getBriefingQueue(), getWorkflowsQueue()];
  let removed = 0;

  for (const queue of queues) {
    // A dev convenience must never fail boot.
    try {
      for (const scheduler of await queue.getJobSchedulers()) {
        await queue.removeJobScheduler(scheduler.key);
        removed += 1;
      }
    } catch (err) {
      console.error(`[runtime] could not clear schedulers on ${queue.name}:`, toMessage(err));
    }
  }

  return removed;
}

/** The runtime owns registration order, worker start order, and reverse teardown order. */
export function createAssistantRuntime(config: RuntimeConfig): AssistantRuntime {
  return {
    async start(): Promise<void> {
      await warmPool();
      // #453: a half-converted credential table must fail the boot, not degrade.
      // See `docs/runbooks/oauth-credential-vault-rollout.md`.
      await config.assertCredentialsReady();
      // ADR-0035: without `model_prices.context_window` the compactor cannot size
      // its threshold, and the boss loops unbounded.
      await verifyMeteringModels();

      // ADR-0018: settle MCP invocations a prior process left in flight, before
      // any worker can pick up an MCP call. Ambiguous writes stay blocked.
      await reconcileInflightInvocations();

      await initEventBridge();
      await initReplicachePokeBridge();

      // Built-ins first: a leased job may name one of them.
      config.registerRecipes();
      // System-tool ports, after the built-ins and before any dispatch.
      registerRuntimeAdapters();

      config.registerUserCreated(async (user) => {
        await seedBuiltinWorkflowsForUser(user.id);
        await ensureDefaultActionPolicyForUser(user.id);
      });

      await seedBuiltinWorkflowsForAllUsers();
      await startPolicyBustSubscriber();

      // The pool ceiling derives from this same value (#437), so throughput cannot outrun the pool.
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

      // Crons spend money and send mail with nobody watching, so they are off
      // outside production unless enabled. `pnpm dev` runs under `tsx watch`,
      // which can outlive its terminal: one orphan once ran for three days.
      // Workers still run: they only act on jobs someone enqueued.
      if (scheduledJobsEnabled()) {
        startMcpConnectionRecovery();
        // Frees old `event_receipts` bodies. Gated like the crons; `stop()` stops it.
        startReceiptPayloadReaper();
        // Re-runs document-ask threads that a lost media job left. Gated: dev needs no recovery,
        // and an ungated pass would resolve rows under DB tests.
        startDocumentAskReconciler();
        await scheduleRepeatableIngestionJobs();
        await scheduleRepeatableMemoryJobs();
        await scheduleRepeatableBriefingJobs();
        await scheduleRepeatableWorkflowsJobs();
      } else {
        const removed = await clearPersistedJobSchedulers();
        console.log(
          `[runtime] scheduled jobs are OFF — workers still run, but no cron will fire${
            removed > 0 ? `; removed ${removed} scheduler(s) a previous run left in Redis` : ""
          }. Set ALFRED_RUN_SCHEDULED_JOBS=true to enable them.`,
        );
      }
    },

    async stop(): Promise<void> {
      // Keep the order, but attempt every step. The reaper's position is not
      // load-bearing: no step waits on it. Row locks keep it safe beside the workers.
      // After `drainMs`, `stop()` may return while one reaper `UPDATE` still runs.
      await runShutdownStep("receipt-payload reaper", stopReceiptPayloadReaper);
      await runShutdownStep("document-ask reconciler", stopDocumentAskReconciler);
      await runShutdownStep("MCP connection recovery", stopMcpConnectionRecovery);
      const agentWorkerStopped = await runShutdownStep("agent worker", stopAgentWorker);
      await runShutdownStep("sub-agent join-wake worker", stopSubAgentJoinWakeWorker);
      // This worker enqueues agent runs, so it stops before the agent queue closes.
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

      // A worker that failed to stop keeps its adapters, so a leased job still finds them.
      if (!agentWorkerStopped) {
        console.warn("System-tool adapters retained because the agent worker did not stop");
      }

      if (!ingestionWorkerStopped) {
        console.warn("Ingestion adapters retained because the ingestion worker did not stop");
      }

      unregisterRuntimeAdapters({ agentWorkerStopped, ingestionWorkerStopped });

      try {
        // Flush before the pool and Redis close: metering writes need the pool,
        // and Langfuse batches spans, so a redeploy would drop a short turn's trace.
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
