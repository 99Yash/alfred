/**
 * Inbound ingress registry (ADR-0097): the typed source descriptors behind
 * `POST /webhooks/inbound/:source`, the shared receive path, the delivery job
 * body, and the per-source subscription health that trigger readiness reads.
 *
 * This is its own door, not part of `@alfred/assistant/connections`, for the
 * same reason `./ingestion` is: `deliver.ts` reaches the trigger bus, and the
 * automation module reads `health.ts`, so folding it into the barrel would put
 * the bus on every operational script's import path. Nothing here imports
 * `../ingestion/queue`; the HTTP route supplies the enqueue function.
 */
export type {
  InboundDedupRule,
  InboundOwner,
  InboundProjection,
  InboundSourceDescriptor,
  InboundSubscriptionAdapter,
  InboundSubscriptionHealth,
} from "./descriptor";
export { INBOUND_SOURCES, inboundSource } from "./registry";
export { githubInstallationId } from "./github";
export {
  INBOUND_VERIFICATION_RESULT,
  receiveInboundDelivery,
  type InboundDeliveryOutcome,
  type ReceiveInboundDeliveryArgs,
} from "./receive";
export { deliverInboundReceipt } from "./deliver";
export { readInboundTriggerHealth } from "./health";
