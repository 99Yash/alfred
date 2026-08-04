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
  registerAgentSystemToolAdapter,
  registerBuiltinTools,
  registerOnUserCreated,
  registerWorkflowSystemToolAdapter,
  registerRuntimeAdapters,
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
  unregisterRuntimeAdapters,
  verifyMeteringModels,
  warmPool,
} from "@alfred/api/runtime";
import { flushLangfuse, flushMeteringWrites } from "@alfred/ai";
import { toMessage } from "@alfred/contracts";
import { assertPersistedCredentialsSealed } from "@alfred/db/credential-vault-maintenance";
import { serverEnv } from "@alfred/env/server";
import { registerBuiltinWorkflows } from "./builtins";

/**
 * Upper bound on the observability flush during shutdown/crash. A stalled
 * network flush (metering rows, Langfuse span batch, Sentry) must never hold
 * teardown open until the platform SIGKILLs — a prompt exit matters more than a
 * straggling cost row or span. Shared by graceful shutdown here and the crash
 * handler in `index.ts` so the two bounds can't drift.
 */
export const OBSERVABILITY_FLUSH_TIMEOUT_MS = 2500;

async function runShutdownStep(label: string, step: () => Promise<void>): Promise<boolean> {
  try {
    await step();
    return true;
  } catch (err) {
    console.error(`Error during shutdown step ${label}:`, toMessage(err));
    return false;
  }
}

export async function startRuntime(): Promise<void> {
  await warmPool();
  // #453 boot gate, before anything can serve a request or lease a job. A
  // process that starts against a half-converted credential table would throw
  // on every token read AND rewrite plaintext behind the operator's back, so
  // an unfinished backfill must fail the boot instead of degrading quietly.
  // See `docs/runbooks/oauth-credential-vault-rollout.md`.
  await assertPersistedCredentialsSealed();
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
  // The system tools reach three agent behaviors (sub-agent spawn/join and
  // chat-history retrieval) through a registered tool-runtime seam, so the tools
  // module holds no agent import (ADR-0089). Install the agent-side handler here,
  // after the tools register, so a first system-tool call finds it.
  registerAgentSystemToolAdapter();
  // The three workflow-authoring system tools reach workflow authoring,
  // revision, recovery, and readiness behind a registered tool-runtime seam, so
  // the tools module holds no workflows import (ADR-0089). Install the
  // workflow-side handler here, after the tools register, so a first
  // system-tool call finds it.
  registerWorkflowSystemToolAdapter();
  registerRuntimeAdapters();

  registerOnUserCreated(async (user) => {
    await seedBuiltinWorkflowsForUser(user.id);
    await ensureDefaultActionPolicyForUser(user.id);
  });

  await seedBuiltinWorkflowsForAllUsers();
  await startPolicyBustSubscriber();

  // Concurrency is env-tunable (#437). It is also the *only* knob: the shared
  // `pg.Pool` ceiling every one of these workers draws from is derived from the
  // same value (`@alfred/env/pool`), so raising throughput can't silently
  // outrun the pool it runs against.
  await startAgentWorker({ concurrency: serverEnv().AGENT_WORKER_CONCURRENCY });
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
