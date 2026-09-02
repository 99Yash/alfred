/**
 * Connected-account lifecycle, OAuth state, credential binding, provider
 * availability, watches, webhooks, provider ingestion coordination.
 *
 * This barrel is the module's product surface: provider availability, object
 * state, credential lifecycle, the OAuth CSRF state store every integration's
 * connect/callback pair signs and verifies through, and the post-callback domain
 * event.
 *
 * It deliberately does NOT re-export `./ingestion`. That submodule has its own
 * door (`@alfred/assistant/connections/ingestion`) because importing it evaluates
 * the BullMQ ingestion queue and the whole Gmail ingestion graph, and this barrel
 * is reached by every operational script. It used to reach them through
 * `@alfred/api/backend`'s `export *`; that door is deleted and the scripts name
 * this barrel directly, so the cost is unchanged. For the same reason
 * `./oauth-state` imports the
 * `./ingestion/workflow-recovery` leaf directly rather than the ingestion barrel.
 *
 * It does NOT re-export `./mcp` either, for the same reason at a different cost:
 * importing that subtree evaluates a process-lifetime live-client cache and the
 * credential vault. It has its own door, `@alfred/assistant/connections/mcp`.
 *
 * `check:architecture` enforces all three of those lines, as one rule: this file must
 * not transitively reach `./ingestion/{queue,gmail-ingest}` or `./mcp/{client,oauth}`,
 * and a violation is reported with the importer chain that produced it. The rule is a
 * reachability walk rather than a module edge because no edge exists to see —
 * `moduleForPath` files `./ingestion/*` and `./mcp/*` inside this same `connections`
 * module. That is what made the widening invisible before: adding
 * `export * from "./ingestion"` here takes this barrel from 19 to 41 exports with
 * every gate green, and a module-load probe reports the same retained-handle count
 * and exit code, because the queue builds its BullMQ objects lazily.
 *
 * What lives in `packages/http/src/connections/` is transport: the Elysia routes and
 * the webhooks (campaign item 24). MCP is no longer among them — the product half is
 * here, and its transport leaf lives at `packages/http/src/mcp.ts`.
 */

export * from "./availability";
export * from "./google-credential-lifecycle";
export {
  createPinnedDispatcher,
  hasCredentialQuery,
  HostedEndpointError,
  hostedEndpointErrorFrom,
  isBlockedHost,
  isBlockedIp,
  isCredentialParamName,
  pinningLookup,
  validatePublicWebUrl,
  type DnsLookupAll,
  type HostedDispatcherTimeouts,
} from "./hosted-endpoint";
export * from "./object-state";
export {
  consumeOAuthNonce,
  rememberOAuthNonce,
  signOAuthState,
  verifyOAuthState,
  type IssueNonceArgs,
  type SignedOAuthState,
} from "./oauth-state";
export { publishGoogleCallbackCompleted } from "./google-callback-events";
