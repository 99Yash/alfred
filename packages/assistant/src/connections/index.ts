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
 * is reached by `@alfred/api/backend`'s `export *` and therefore by every
 * operational script. For the same reason `./oauth-state` imports the
 * `./ingestion/workflow-recovery` leaf directly rather than the ingestion barrel.
 *
 * NOTHING ENFORCES EITHER OF THOSE TWO LINES TODAY. Adding
 * `export * from "./ingestion"` here widens this barrel from 19 to 41 exports and
 * every gate stays green: `check:architecture` files `./ingestion/*` inside this
 * same `connections` module, so it sees no edge; a module-load probe reports the
 * same retained-handle count and exit code, because the queue builds its BullMQ
 * objects lazily. Campaign item 52 owns the assertion that turns this paragraph
 * into a gate — that this file does not transitively reach
 * `./ingestion/{queue,gmail-ingest}`. Until it lands, keep the two lines by review.
 *
 * What still lives in `packages/api/src/modules/connections/` is transport and
 * protocol: the Elysia routes, the webhooks, and `mcp` (campaign items 24, 48, 51).
 */

export * from "./availability";
export * from "./google-credential-lifecycle";
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
