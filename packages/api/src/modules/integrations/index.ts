import { Elysia } from "elysia";
import { githubIntegrationRoutes } from "./github-routes";
import { githubWebhookRoutes } from "./github-webhook";
import { gmailWebhookRoutes } from "./gmail-webhook";
import { googleIntegrationRoutes } from "./google-routes";
import { notionIntegrationRoutes } from "./notion-routes";
import { railwayIntegrationRoutes } from "./railway-routes";
import { vercelIntegrationRoutes } from "./vercel-routes";

export {
  startIngestionWorker,
  stopIngestionWorker,
  closeIngestionQueue,
  enqueueChatAttachmentEnrichment,
  enqueueGmailKindRefold,
  enqueuePendingUploadCleanup,
  getIngestionQueue,
} from "./queue";
export { readIntegrationAvailability } from "./availability";
export type { IngestionJobData } from "./queue";
export {
  consumeOAuthNonce,
  rememberOAuthNonce,
  signOAuthState,
  verifyOAuthState,
} from "./oauth-state";
export { scheduleRepeatableIngestionJobs } from "./repeatable";
export {
  registerChatMediaHandler,
  type ChatMediaHandler,
  type ChatMediaPendingUploadCleanupRequest,
} from "./chat-media";
export {
  registerGmailUserModelHandler,
  type GmailKindRefoldResult,
  type GmailUserModelHandler,
} from "./gmail-user-model";
export {
  registerGoogleCredentialLifecycleHandler,
  type GoogleCredentialLifecycleHandler,
} from "./google-credential-lifecycle";
export {
  registerGmailTriageHandler,
  type GmailTriageHandler,
  type GmailTriageRelabelResult,
} from "./gmail-triage";
export { registerWorkflowRecoveryHandler, type WorkflowRecoveryResult } from "./workflow-recovery";

export const integrations = new Elysia({ name: "integrations", normalize: "typebox" })
  .use(googleIntegrationRoutes)
  .use(githubIntegrationRoutes)
  .use(notionIntegrationRoutes)
  .use(railwayIntegrationRoutes)
  .use(vercelIntegrationRoutes)
  .use(gmailWebhookRoutes)
  .use(githubWebhookRoutes);
