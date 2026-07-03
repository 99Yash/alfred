export { closeConnections, warmPool } from "@alfred/db";
export { closeRedis } from "./queue/connection.js";
export { initEventBridge, closeEventBridge } from "./events/index.js";
export { initReplicachePokeBridge, closeReplicachePokeBridge } from "./events/replicache-events.js";
export {
  closeAgentQueue,
  closeSubAgentJoinWakeQueue,
  registerWorkflow,
  startAgentWorker,
  startSubAgentJoinWakeWorker,
  stopAgentWorker,
  stopSubAgentJoinWakeWorker,
  verifyMeteringModels,
} from "./modules/agent/index.js";
export {
  closeApprovalExpiryQueue,
  closeApprovalNotificationQueue,
  startApprovalExpiryWorker,
  startApprovalNotificationWorker,
  stopApprovalExpiryWorker,
  stopApprovalNotificationWorker,
} from "./modules/approvals/index.js";
export {
  ensureDefaultActionPolicyForUser,
  startPolicyBustSubscriber,
  stopPolicyBustSubscriber,
} from "./modules/action-policies/index.js";
export {
  closeBriefingQueue,
  scheduleRepeatableBriefingJobs,
  startBriefingWorker,
  stopBriefingWorker,
} from "./modules/briefing/index.js";
export {
  closeIngestionQueue,
  scheduleRepeatableIngestionJobs,
  startIngestionWorker,
  stopIngestionWorker,
} from "./modules/integrations/index.js";
export {
  closeMemoryQueue,
  scheduleRepeatableMemoryJobs,
  startMemoryWorker,
  stopMemoryWorker,
} from "./modules/memory/index.js";
export { registerBuiltinTools } from "./modules/tools/index.js";
export {
  scheduleRepeatableWorkflowsJobs,
  seedBuiltinWorkflowsForAllUsers,
  seedBuiltinWorkflowsForUser,
  closeWorkflowsQueue,
  startWorkflowsWorker,
  stopWorkflowsWorker,
} from "./modules/workflows/index.js";
export { registerOnUserCreated, type OnUserCreatedHook } from "@alfred/auth";
