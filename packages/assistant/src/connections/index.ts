/**
 * Connections barrel: availability, object state, credential lifecycle, OAuth state, callback events.
 * It does not re-export `./ingestion` or `./mcp`: they load the BullMQ queue,
 * the Gmail graph, a live-client cache, and the vault. Each has its own subpath.
 * `check:architecture` walks reachability to enforce this, because the queue builds
 * lazily and no load probe would notice. HTTP routes live in `packages/http/src/connections/`.
 */

export * from "./availability";

export { readDeliveryAlerts, toDeliveryAlerts, type DeliveryAlertVerdict } from "./delivery-alerts";

export {
  eventDeliveryRows,
  readEventSourceHealth,
  type AccountDeliveryHealthReader,
  type EventSourceHealth,
  type EventSourceHealthMap,
} from "./event-source-health";

export * from "./google-credential-lifecycle";

export {
  documentAskReducer,
  gmailMessageLocatorSchema,
  type DocumentAskNoopReason,
  type DocumentAskOpenResult,
  type DocumentAskReducer,
  type DocumentAskResolution,
  type GmailMessageLocator,
  type OpenDocumentAskInput,
  startDocumentAskReconciler,
  stopDocumentAskReconciler,
} from "./document-asks";

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

export {
  approvedMcpHealthExternalId,
  deliveryInstantNow,
  deliveryInstantOf,
  firstClosingObject,
  MCP_APPROVED_HEALTH_EVENT_TYPE,
  MCP_APPROVED_HEALTH_KEY_KIND,
  MCP_APPROVED_HEALTH_KIND,
  objectStateFoldConsumers,
  objectStateStore,
  proposeObjectKeys,
  reconcileEvidence,
  selectPrimaryReconciledObject,
  receiptDeliveryInstant,
  type CandidateKey,
  type ClosureReading,
  type DeliveryInstant,
  type ObjectState,
  type ObjectStateStore,
  type ReconcileCandidates,
  type ReconcileResult,
  type ReconciledObject,
} from "./object-state";

export {
  consumeOAuthNonce,
  rememberOAuthNonce,
  signOAuthState,
  verifyOAuthState,
  type IssueNonceArgs,
  type SignedOAuthState,
} from "./oauth-state";

export { publishGoogleCallbackCompleted } from "./google-callback-events";

export { readRawReceiptInventory, seenRawKinds } from "./raw-receipt-inventory";

export { readReceiptDocument, type ReceiptDocument } from "./ingestion/receipt-document";

export { GMAIL_POLL_SWEEP_INTERVAL_MS } from "./ingestion/gmail-delivery-policy";

export {
  gmailPushStaleStatus,
  readGmailDeliveryFacts,
  type GmailDeliveryFacts,
} from "./ingestion/gmail-delivery-facts";
