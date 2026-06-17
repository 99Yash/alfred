import { Elysia } from "elysia";
import { githubIntegrationRoutes } from "./github-routes";
import { githubWebhookRoutes } from "./github-webhook";
import { gmailWebhookRoutes } from "./gmail-webhook";
import { googleIntegrationRoutes } from "./google-routes";
import { notionIntegrationRoutes } from "./notion-routes";
import { railwayIntegrationRoutes } from "./railway-routes";
import { toolTiersRoutes } from "./tool-tiers-routes";
import { vercelIntegrationRoutes } from "./vercel-routes";

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
  .use(notionIntegrationRoutes)
  .use(railwayIntegrationRoutes)
  .use(vercelIntegrationRoutes)
  .use(gmailWebhookRoutes)
  .use(githubWebhookRoutes)
  .use(toolTiersRoutes);
