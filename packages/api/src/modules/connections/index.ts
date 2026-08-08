import { Elysia } from "elysia";
import { githubIntegrationRoutes } from "./github-routes";
import { githubWebhookRoutes } from "./github-webhook";
import { gmailWebhookRoutes } from "./gmail-webhook";
import { googleIntegrationRoutes } from "./google-routes";
import { notionIntegrationRoutes } from "./notion-routes";
import { railwayIntegrationRoutes } from "./railway-routes";
import { vercelIntegrationRoutes } from "./vercel-routes";

export {
  consumeOAuthNonce,
  rememberOAuthNonce,
  signOAuthState,
  verifyOAuthState,
} from "./oauth-state";
export { scheduleRepeatableIngestionJobs } from "./repeatable";
export { publishGoogleCallbackCompleted } from "./google-routes";
export {
  getMcpExecutionBroker,
  listMcpToolsLocal,
  resolveMcpCallRiskTier,
  type ExternalToolRef,
  type McpBrokerOutcome,
  type McpCallEnvelope,
} from "./mcp";

export const connections = new Elysia({ name: "connections", normalize: "typebox" })
  .use(googleIntegrationRoutes)
  .use(githubIntegrationRoutes)
  .use(notionIntegrationRoutes)
  .use(railwayIntegrationRoutes)
  .use(vercelIntegrationRoutes)
  .use(gmailWebhookRoutes)
  .use(githubWebhookRoutes);
