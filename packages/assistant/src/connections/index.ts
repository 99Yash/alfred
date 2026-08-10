/**
 * Connected-account lifecycle, OAuth state, credential binding, provider
 * availability, watches, webhooks, provider ingestion coordination.
 *
 * This module exports only the cleanly-movable surface:
 * - `readIntegrationAvailability` / `readFreshIntegrationAvailability`
 * - `objectStateStore` / `isGithubNotificationSender` / `extractGithubKeys`
 * - `registerGoogleCredentialLifecycleHandler` / `GoogleCredentialLifecycleHandler`
 *
 * Tangled parts stay in `packages/api/src/modules/connections/`: routes, webhooks,
 * oauth-state, repeatable, mcp. `@alfred/api/backend` re-exports this module's clean
 * surface and `mcp`; `@alfred/api/runtime` re-exports `scheduleRepeatableIngestionJobs`
 * from `repeatable`. The routes, the webhooks and `oauth-state` are behind neither
 * door: the route plugin is reached by relative path from `packages/api/src/index.ts`.
 */

export * from "./availability";
export * from "./google-credential-lifecycle";
export * from "./object-state";
