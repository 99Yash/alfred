import type { CredentialProvider } from "@alfred/contracts";
import { Elysia, type AnyElysia } from "elysia";
import { githubIntegrationRoutes } from "./github-routes";
import { gmailWebhookRoutes } from "./gmail-webhook";
import { inboundWebhookRoutes } from "./inbound-webhook";
import { googleIntegrationRoutes } from "./google-routes";
import { notionIntegrationRoutes } from "./notion-routes";
import { sentryIntegrationRoutes } from "./sentry-routes";
import { vercelIntegrationRoutes } from "./vercel-routes";

/**
 * One route family per live provider (ADR-0093); a gap is a compile error.
 * Still mounted one by one below, so Eden sees the route types.
 */
const providerRoutes = {
  google: googleIntegrationRoutes,
  github: githubIntegrationRoutes,
  notion: notionIntegrationRoutes,
  sentry: sentryIntegrationRoutes,
  vercel: vercelIntegrationRoutes,
} satisfies Record<CredentialProvider, AnyElysia>;

export const connections = new Elysia({ name: "connections", normalize: "typebox" })
  .use(providerRoutes.google)
  .use(providerRoutes.github)
  .use(providerRoutes.notion)
  .use(providerRoutes.sentry)
  .use(providerRoutes.vercel)
  .use(gmailWebhookRoutes)
  .use(inboundWebhookRoutes);
