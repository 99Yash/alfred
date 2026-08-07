import { Elysia } from "elysia";
import { githubIntegrationRoutes } from "./github-routes";
import { githubWebhookRoutes } from "./github-webhook";
import { gmailWebhookRoutes } from "./gmail-webhook";
import { googleIntegrationRoutes } from "./google-routes";
import { notionIntegrationRoutes } from "./notion-routes";
import { railwayIntegrationRoutes } from "./railway-routes";
import { vercelIntegrationRoutes } from "./vercel-routes";

export { readIntegrationAvailability, readFreshIntegrationAvailability } from "./availability";
export {
  consumeOAuthNonce,
  rememberOAuthNonce,
  signOAuthState,
  verifyOAuthState,
} from "./oauth-state";
export { scheduleRepeatableIngestionJobs } from "./repeatable";
export {
  registerGoogleCredentialLifecycleHandler,
  type GoogleCredentialLifecycleHandler,
} from "./google-credential-lifecycle";
export * from "./object-state/index";
export { publishGoogleCallbackCompleted } from "./google-routes";

export const connections = new Elysia({ name: "connections", normalize: "typebox" })
  .use(googleIntegrationRoutes)
  .use(githubIntegrationRoutes)
  .use(notionIntegrationRoutes)
  .use(railwayIntegrationRoutes)
  .use(vercelIntegrationRoutes)
  .use(gmailWebhookRoutes)
  .use(githubWebhookRoutes);
