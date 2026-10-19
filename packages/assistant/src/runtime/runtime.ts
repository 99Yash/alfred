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
import { closeConnections, warmPool } from "@alfred/db";
import { closeRedis } from "@alfred/db/redis";
import type { Queue } from "bullmq";
import { registerRuntimeAdapters, unregisterRuntimeAdapters } from "./adapters/runtime-adapters";
import { logger } from "@alfred/logging";

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
    logger.error({ err }, `Error during shutdown step ${label}`);

    return false;
  }
}

/** A BullMQ module: one worker, the queue it consumes, and the crons it schedules on that queue. */
interface WorkerService {
  readonly kind: "worker";
  /** Shutdown logs read `<label> worker` and `<label> queue`. */
  readonly label: string;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly close: () => Promise<void>;
  /** `schedule` writes its schedulers on `queue`, so a boot with scheduled jobs off clears that queue. */
  readonly repeatable?: {
    readonly queue: () => Queue;
    readonly schedule: () => Promise<void>;
  };
}

/** An in-process recovery loop. It has no queue and runs only when scheduled jobs are enabled. */
interface ScheduledLoop {
  readonly kind: "scheduled-loop";
  /** The shutdown log label. */
  readonly label: string;
  readonly start: () => void;
  readonly stop: () => Promise<void>;
}

type BackgroundService = WorkerService | ScheduledLoop;

/**
 * Teardown order. Each group stops every member, then closes every member's
 * queue, so a worker that enqueues onto a sibling's queue shares its group:
 * the chat-memory worker enqueues agent runs, so it stops before the agent
 * queue closes. The scheduled loops stop first; no step waits on them, and
 * row locks keep the receipt-payload reaper safe beside the workers.
 * The names here and the keys of `backgroundServices` must match exactly.
 */
const SHUTDOWN_ORDER = [
  ["receiptPayloadReaper", "documentAskReconciler", "mcpConnectionRecovery"],
  ["agent", "subAgentJoinWake", "chatMemory", "conversationCompaction"],
  ["approvalNotification"],
  ["approvalExpiry"],
  ["ingestion"],
  ["memory"],
  ["briefing"],
  ["workflows"],
] as const;

type BackgroundServiceName = (typeof SHUTDOWN_ORDER)[number][number];

/**
 * Every background module, in boot order. Workers start in this order, then
 * (with scheduled jobs on) the loops start and the repeatables register in
 * this order. `satisfies` rejects a key that `SHUTDOWN_ORDER` does not name
 * and a name that has no record, so no module can start without a teardown.
 */
function backgroundServices(config: RuntimeConfig) {
  return {
    agent: {
      kind: "worker",
      label: "agent",
      // The pool ceiling derives from this same value (#437), so throughput cannot outrun the pool.
      start: () => startAgentWorker({ concurrency: config.workerConcurrency }),
      stop: stopAgentWorker,
      close: closeAgentQueue,
    },
    subAgentJoinWake: {
      kind: "worker",
      label: "sub-agent join-wake",
      start: startSubAgentJoinWakeWorker,
      stop: stopSubAgentJoinWakeWorker,
      close: closeSubAgentJoinWakeQueue,
    },
    ingestion: {
      kind: "worker",
      label: "ingestion",
      start: startIngestionWorker,
      stop: stopIngestionWorker,
      close: closeIngestionQueue,
      repeatable: { queue: getIngestionQueue, schedule: scheduleRepeatableIngestionJobs },
    },
    memory: {
      kind: "worker",
      label: "memory",
      start: startMemoryWorker,
      stop: stopMemoryWorker,
      close: closeMemoryQueue,
      repeatable: { queue: getMemoryQueue, schedule: scheduleRepeatableMemoryJobs },
    },
    chatMemory: {
      kind: "worker",
      label: "chat-memory",
      start: startChatMemoryWorker,
      stop: stopChatMemoryWorker,
      close: closeChatMemoryQueue,
    },
    conversationCompaction: {
      kind: "worker",
      label: "conversation-compaction",
      start: startConversationCompactionWorker,
      stop: stopConversationCompactionWorker,
      close: closeConversationCompactionQueue,
    },
    briefing: {
      kind: "worker",
      label: "briefing",
      start: startBriefingWorker,
      stop: stopBriefingWorker,
      close: closeBriefingQueue,
      repeatable: { queue: getBriefingQueue, schedule: scheduleRepeatableBriefingJobs },
    },
    workflows: {
      kind: "worker",
      label: "workflows",
      start: startWorkflowsWorker,
      stop: stopWorkflowsWorker,
      close: closeWorkflowsQueue,
      repeatable: { queue: getWorkflowsQueue, schedule: scheduleRepeatableWorkflowsJobs },
    },
    approvalNotification: {
      kind: "worker",
      label: "approval-notification",
      start: startApprovalNotificationWorker,
      stop: stopApprovalNotificationWorker,
      close: closeApprovalNotificationQueue,
    },
    approvalExpiry: {
      kind: "worker",
      label: "approval-expiry",
      start: startApprovalExpiryWorker,
      stop: stopApprovalExpiryWorker,
      close: closeApprovalExpiryQueue,
    },
    mcpConnectionRecovery: {
      kind: "scheduled-loop",
      label: "MCP connection recovery",
      start: startMcpConnectionRecovery,
      stop: stopMcpConnectionRecovery,
    },
    // Frees old `event_receipts` bodies. After `drainMs`, `stop()` may return
    // while one reaper `UPDATE` still runs.
    receiptPayloadReaper: {
      kind: "scheduled-loop",
      label: "receipt-payload reaper",
      start: startReceiptPayloadReaper,
      stop: stopReceiptPayloadReaper,
    },
    // Re-runs document-ask threads that a lost media job left. Gated: dev needs
    // no recovery, and an ungated pass would resolve rows under DB tests.
    documentAskReconciler: {
      kind: "scheduled-loop",
      label: "document-ask reconciler",
      start: startDocumentAskReconciler,
      stop: stopDocumentAskReconciler,
    },
  } satisfies Record<BackgroundServiceName, BackgroundService>;
}

/**
 * Delete every persisted repeatable job scheduler and return the count.
 * BullMQ keeps schedulers in Redis across restarts, so skipping
 * `scheduleRepeatable*` alone still fires a prior run's crons.
 * Reads the live set, so a scheduler added later is covered too.
 */
async function clearPersistedJobSchedulers(queues: readonly Queue[]): Promise<number> {
  let removed = 0;

  for (const queue of queues) {
    // A dev convenience must never fail boot.
    try {
      for (const scheduler of await queue.getJobSchedulers()) {
        await queue.removeJobScheduler(scheduler.key);
        removed += 1;
      }
    } catch (err) {
      logger.error({ err }, `[runtime] could not clear schedulers on ${queue.name}`);
    }
  }

  return removed;
}

/** The runtime owns registration order, worker start order, and teardown order. */
export function createAssistantRuntime(config: RuntimeConfig): AssistantRuntime {
  const services: Record<BackgroundServiceName, BackgroundService> = backgroundServices(config);
  const bootOrder = Object.values(services);

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

      for (const service of bootOrder) {
        if (service.kind === "worker") await service.start();
      }

      // Crons spend money and send mail with nobody watching, so they are off
      // outside production unless enabled. `pnpm dev` runs under `tsx watch`,
      // which can outlive its terminal: one orphan once ran for three days.
      // Workers still run: they only act on jobs someone enqueued.
      if (scheduledJobsEnabled()) {
        for (const service of bootOrder) {
          if (service.kind === "scheduled-loop") service.start();
        }

        for (const service of bootOrder) {
          if (service.kind === "worker" && service.repeatable) await service.repeatable.schedule();
        }
      } else {
        const removed = await clearPersistedJobSchedulers(
          bootOrder.flatMap((service) =>
            service.kind === "worker" && service.repeatable ? [service.repeatable.queue()] : [],
          ),
        );

        logger.info(
          `[runtime] scheduled jobs are OFF — workers still run, but no cron will fire${
            removed > 0 ? `; removed ${removed} scheduler(s) a previous run left in Redis` : ""
          }. Set ALFRED_RUN_SCHEDULED_JOBS=true to enable them.`,
        );
      }
    },

    async stop(): Promise<void> {
      // Keep the order, but attempt every step.
      const stopped = new Set<BackgroundServiceName>();

      for (const group of SHUTDOWN_ORDER) {
        for (const name of group) {
          const service = services[name];
          const label = service.kind === "worker" ? `${service.label} worker` : service.label;

          if (await runShutdownStep(label, service.stop)) stopped.add(name);
        }

        for (const name of group) {
          const service = services[name];

          if (service.kind === "worker") {
            await runShutdownStep(`${service.label} queue`, service.close);
          }
        }
      }

      logger.info("Worker shutdown attempted");

      const agentWorkerStopped = stopped.has("agent");
      const ingestionWorkerStopped = stopped.has("ingestion");

      // A worker that failed to stop keeps its adapters, so a leased job still finds them.
      if (!agentWorkerStopped) {
        logger.warn("System-tool adapters retained because the agent worker did not stop");
      }

      if (!ingestionWorkerStopped) {
        logger.warn("Ingestion adapters retained because the ingestion worker did not stop");
      }

      unregisterRuntimeAdapters({ agentWorkerStopped, ingestionWorkerStopped });

      try {
        // Flush before the pool and Redis close: metering writes need the pool,
        // and Langfuse batches spans, so a redeploy would drop a short turn's trace.
        await config.flushObservability();
        logger.info("Observability flushed");
      } catch (err) {
        logger.error({ err }, "Error flushing observability");
      }

      try {
        await stopPolicyBustSubscriber();
        await closeEventBridge();
        await closeReplicachePokeBridge();
        await closeRedis();
        logger.info("Redis closed");
      } catch (err) {
        logger.error({ err }, "Error closing Redis");
      }

      try {
        await closeConnections();
        logger.info("DB pool closed");
      } catch (err) {
        logger.error({ err }, "Error closing DB");
      }
    },
  };
}
