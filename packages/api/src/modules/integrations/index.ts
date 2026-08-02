import { Elysia } from "elysia";
import { githubIntegrationRoutes } from "./github-routes";
import { githubWebhookRoutes } from "./github-webhook";
import { gmailWebhookRoutes } from "./gmail-webhook";
import { googleIntegrationRoutes } from "./google-routes";
import { notionIntegrationRoutes } from "./notion-routes";
import { mcpIntegrationRoutes } from "./mcp-routes";
import { railwayIntegrationRoutes } from "./railway-routes";
import { toolTiersRoutes } from "./tool-tiers-routes";
import { vercelIntegrationRoutes } from "./vercel-routes";

export {
  startIngestionWorker,
  stopIngestionWorker,
  closeIngestionQueue,
  enqueueGmailKindRefold,
  getIngestionQueue,
} from "./queue";
export type { IngestionJobData } from "./queue";
export { scheduleRepeatableIngestionJobs } from "./repeatable";
export {
  captureGmailObservations,
  gmailKindRefoldRequestSchema,
  gmailKindRefoldResultSchema,
  gmailKindRefoldSweepRequestSchema,
  gmailKindRefoldSweepResultSchema,
  gmailObservationCaptureRequestSchema,
  gmailObservationCaptureResultSchema,
  NoGmailUserModelHandlerRegisteredError,
  refoldGmailKindProjection,
  registerGmailUserModelHandler,
  scheduleGmailKindRefoldSweep,
  type GmailKindRefoldRequest,
  type GmailKindRefoldResult,
  type GmailKindRefoldSweepRequest,
  type GmailKindRefoldSweepResult,
  type GmailObservationCaptureRequest,
  type GmailObservationCaptureResult,
  type GmailUserModelHandler,
} from "./gmail-user-model";
export {
  gmailPostInsertTriageRequestSchema,
  gmailPostInsertTriageResultSchema,
  gmailTriageRelabelRequestSchema,
  gmailTriageRelabelResultSchema,
  NoGmailTriageHandlerRegisteredError,
  registerGmailTriageHandler,
  runGmailPostInsertTriage,
  runGmailTriageRelabel,
  type GmailPostInsertTriageRequest,
  type GmailPostInsertTriageResult,
  type GmailTriageHandler,
  type GmailTriageRelabelRequest,
  type GmailTriageRelabelResult,
} from "./gmail-triage";
export {
  registerWorkflowRecoveryHandler,
  resolveWorkflowRecoveryTarget,
  workflowRecoveryRequestSchema,
  workflowRecoveryResultSchema,
  workflowRecoveryStateSchema,
  type WorkflowRecoveryHandler,
  type WorkflowRecoveryRequest,
  type WorkflowRecoveryResult,
} from "./workflow-recovery";

export const integrations = new Elysia({ name: "integrations", normalize: "typebox" })
  .use(googleIntegrationRoutes)
  .use(githubIntegrationRoutes)
  .use(notionIntegrationRoutes)
  .use(mcpIntegrationRoutes)
  .use(railwayIntegrationRoutes)
  .use(vercelIntegrationRoutes)
  .use(gmailWebhookRoutes)
  .use(githubWebhookRoutes)
  .use(toolTiersRoutes);
