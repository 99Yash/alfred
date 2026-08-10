import { Elysia } from "elysia";
import { githubIntegrationRoutes } from "./github-routes";
import { githubWebhookRoutes } from "./github-webhook";
import { gmailWebhookRoutes } from "./gmail-webhook";
import { googleIntegrationRoutes } from "./google-routes";
import { notionIntegrationRoutes } from "./notion-routes";
import { railwayIntegrationRoutes } from "./railway-routes";
import { vercelIntegrationRoutes } from "./vercel-routes";

// The last re-export block on this file. `modules/tools/mcp.ts` reaches the mcp
// surface through it because a `../connections/mcp` spelling is a private
// assistant-module import (`check-module-architecture.mjs`: only the module's own
// `index.ts` is its public face). Campaign item 48 moves the 13 pure-logic mcp
// files to `@alfred/assistant`, which turns that consumer into a bare package
// specifier and lets this block go — which is what finally makes this file movable
// into `@alfred/http` at item 24.
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
