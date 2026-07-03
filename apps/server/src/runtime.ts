import {
  closeAgentQueue,
  closeApprovalExpiryQueue,
  closeApprovalNotificationQueue,
  closeBriefingQueue,
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
  startIngestionWorker,
  startMemoryWorker,
  startPolicyBustSubscriber,
  startSubAgentJoinWakeWorker,
  startWorkflowsWorker,
  stopAgentWorker,
  stopApprovalExpiryWorker,
  stopApprovalNotificationWorker,
  stopBriefingWorker,
  stopIngestionWorker,
  stopMemoryWorker,
  stopPolicyBustSubscriber,
  stopSubAgentJoinWakeWorker,
  stopWorkflowsWorker,
  verifyMeteringModels,
  warmPool,
} from "@alfred/api/runtime";
import { toMessage } from "@alfred/contracts";
import { registerBuiltinWorkflows } from "./builtins";

export async function startRuntime(): Promise<void> {
  await warmPool();
  // ADR-0035 guard: every agent model must have a populated
  // `model_prices.context_window`. A missing value means the compactor
  // can't size its 60% threshold, so the boss would loop unbounded.
  await verifyMeteringModels();
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
    await closeAgentQueue();
    await closeSubAgentJoinWakeQueue();
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
