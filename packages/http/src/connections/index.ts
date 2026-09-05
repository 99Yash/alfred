import type { CredentialProvider } from "@alfred/contracts";
import { Elysia, type AnyElysia } from "elysia";
import { githubIntegrationRoutes } from "./github-routes";
import { gmailWebhookRoutes } from "./gmail-webhook";
import { inboundWebhookRoutes } from "./inbound-webhook";
import { googleIntegrationRoutes } from "./google-routes";
import { notionIntegrationRoutes } from "./notion-routes";
import { railwayIntegrationRoutes } from "./railway-routes";
import { sentryIntegrationRoutes } from "./sentry-routes";
import { vercelIntegrationRoutes } from "./vercel-routes";

/**
 * One route family per credential provider (ADR-0093). A live provider the
 * registry knows with no route family, or a route family for a provider it does
 * not know, is a compile error here. The plugins are still mounted one by one
 * below so their route types reach the Eden client.
 */
const providerRoutes = {
  google: googleIntegrationRoutes,
  github: githubIntegrationRoutes,
  notion: notionIntegrationRoutes,
  railway: railwayIntegrationRoutes,
  sentry: sentryIntegrationRoutes,
  vercel: vercelIntegrationRoutes,
} satisfies Record<CredentialProvider, AnyElysia>;

export const connections = new Elysia({ name: "connections", normalize: "typebox" })
  .use(providerRoutes.google)
  .use(providerRoutes.github)
  .use(providerRoutes.notion)
  .use(providerRoutes.railway)
  .use(providerRoutes.sentry)
  .use(providerRoutes.vercel)
  .use(gmailWebhookRoutes)
  .use(inboundWebhookRoutes);
