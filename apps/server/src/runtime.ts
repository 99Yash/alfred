import {
  closeAgentQueue,
  closeApprovalExpiryQueue,
  closeApprovalNotificationQueue,
  closeBriefingQueue,
  closeChatMemoryQueue,
  closeConversationCompactionQueue,
  closeConnections,
  closeEventBridge,
  closeIngestionQueue,
  closeMemoryQueue,
  closeRedis,
  closeReplicachePokeBridge,
  closeSubAgentJoinWakeQueue,
  closeWorkflowsQueue,
  ensureDefaultActionPolicyForUser,
  initEventBridge,
  initReplicachePokeBridge,
  reconcileInflightInvocations,
  registerBuiltinTools,
  registerOnUserCreated,
  scheduleRepeatableBriefingJobs,
  scheduleRepeatableIngestionJobs,
  scheduleRepeatableMemoryJobs,
  scheduleRepeatableWorkflowsJobs,
  seedBuiltinWorkflowsForAllUsers,
  seedBuiltinWorkflowsForUser,
  startAgentWorker,
  startApprovalExpiryWorker,
  startApprovalNotificationWorker,
  startBriefingWorker,
  startChatMemoryWorker,
  startConversationCompactionWorker,
  startIngestionWorker,
  startMemoryWorker,
  startPolicyBustSubscriber,
  startSubAgentJoinWakeWorker,
  startWorkflowsWorker,
  stopAgentWorker,
  stopApprovalExpiryWorker,
  stopApprovalNotificationWorker,
  stopBriefingWorker,
  stopChatMemoryWorker,
  stopConversationCompactionWorker,
  stopIngestionWorker,
  stopMemoryWorker,
  stopPolicyBustSubscriber,
  stopSubAgentJoinWakeWorker,
  stopWorkflowsWorker,
  verifyMeteringModels,
  warmPool,
} from "@alfred/api/runtime";
import { flushLangfuse, flushMeteringWrites } from "@alfred/ai";
import { toMessage } from "@alfred/contracts";
import { registerBuiltinWorkflows } from "./builtins";

/**
 * Upper bound on the observability flush during shutdown/crash. A stalled
 * network flush (metering rows, Langfuse span batch, Sentry) must never hold
 * teardown open until the platform SIGKILLs — a prompt exit matters more than a
 * straggling cost row or span. Shared by graceful shutdown here and the crash
 * handler in `index.ts` so the two bounds can't drift.
 */
export const OBSERVABILITY_FLUSH_TIMEOUT_MS = 2500;

export async function startRuntime(): Promise<void> {
  await warmPool();
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
  // their workflow or tool names.
  registerBuiltinWorkflows();
  registerBuiltinTools();

  registerOnUserCreated(async (user) => {
    await seedBuiltinWorkflowsForUser(user.id);
    await ensureDefaultActionPolicyForUser(user.id);
  });

  await seedBuiltinWorkflowsForAllUsers();
  await startPolicyBustSubscriber();

  await startAgentWorker();
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
}

export async function stopRuntime(): Promise<void> {
  try {
    // Stop the agent worker first so active steps can finish before Redis goes
    // away. The join-wake worker must stop before the agent queue closes,
    // because late wake jobs enqueue parent runs.
    await stopAgentWorker();
    await stopSubAgentJoinWakeWorker();
    // The chat-memory debounce worker's fire creates + enqueues an agent run, so
    // it must stop before the agent queue closes — same rationale as join-wake.
    await stopChatMemoryWorker();
    await stopConversationCompactionWorker();
    await closeAgentQueue();
    await closeSubAgentJoinWakeQueue();
    await closeChatMemoryQueue();
    await closeConversationCompactionQueue();
    await stopApprovalNotificationWorker();
    await closeApprovalNotificationQueue();
    await stopApprovalExpiryWorker();
    await closeApprovalExpiryQueue();
    await stopIngestionWorker();
    await closeIngestionQueue();
    await stopMemoryWorker();
    await closeMemoryQueue();
    await stopBriefingWorker();
    await closeBriefingQueue();
    await stopWorkflowsWorker();
    await closeWorkflowsQueue();
    console.log("Workers stopped");
  } catch (err) {
    console.error("Error stopping workers:", toMessage(err));
  }

  try {
    // Workers are stopped, so no new metering rows or Langfuse spans will be
    // produced. Flush both before the DB pool and Redis close below: metering
    // writes are fire-and-forget into `api_call_log` and need the pool alive,
    // and Langfuse batches spans on a 15-event / 10s timer — so a short turn's
    // trace is otherwise dropped when a redeploy SIGTERM recycles the process
    // inside that window (the missing follow-up-turn trace). Sentry already
    // flushes on shutdown; this closes the same gap for the LLM observability.
    //
    // Bound the wait (mirrors the crash handler in `index.ts`): a stalled
    // network flush must not hold graceful shutdown open until the platform
    // SIGKILLs — the pool/Redis close below and a prompt exit matter more than a
    // straggling cost row or span batch. `allSettled` so one flush failing
    // doesn't abort the other. `.unref()` the timer so it can never itself keep
    // the event loop alive past the flush it's bounding.
    await Promise.race([
      Promise.allSettled([flushMeteringWrites(), flushLangfuse()]),
      new Promise((resolve) => {
        setTimeout(resolve, OBSERVABILITY_FLUSH_TIMEOUT_MS).unref();
      }),
    ]);
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
}
