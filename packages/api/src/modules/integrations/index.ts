import { Elysia } from "elysia";
import { githubIntegrationRoutes } from "./github-routes";
import { githubWebhookRoutes } from "./github-webhook";
import { gmailWebhookRoutes } from "./gmail-webhook";
import { googleIntegrationRoutes } from "./google-routes";
import { toolTiersRoutes } from "./tool-tiers-routes";

export {
  startIngestionWorker,
  stopIngestionWorker,
  closeIngestionQueue,
  getIngestionQueue,
} from "./queue";
export type { IngestionJobData } from "./queue";
export { scheduleRepeatableIngestionJobs } from "./repeatable";

export const integrations = new Elysia({ name: "integrations", normalize: "typebox" })
  .use(googleIntegrationRoutes)
  .use(githubIntegrationRoutes)
  .use(gmailWebhookRoutes)
  .use(githubWebhookRoutes)
  .use(toolTiersRoutes);
