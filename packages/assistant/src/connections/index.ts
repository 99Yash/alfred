/**
 * Connected-account lifecycle, OAuth state, credential binding, provider
 * availability, watches, webhooks, provider ingestion coordination.
 *
 * This module exports only the cleanly-movable surface:
 * - `readIntegrationAvailability` / `readFreshIntegrationAvailability`
 * - `objectStateStore` / `isGithubNotificationSender` / `extractGithubKeys`
 * - `registerGoogleCredentialLifecycleHandler` / `GoogleCredentialLifecycleHandler`
 *
 * Tangled parts stay in `@alfred/api/modules/connections`: routes, webhooks,
 * oauth-state, repeatable, mcp. The full surface is re-exported from
 * `@alfred/api/backend`.
 */

export * from "./availability";
export * from "./google-credential-lifecycle";
export * from "./object-state";
