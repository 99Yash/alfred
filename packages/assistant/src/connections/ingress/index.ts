/**
 * Inbound ingress registry (ADR-0097): the typed source descriptors behind
 * `POST /webhooks/inbound/:source`, the per-source subscription health that
 * trigger readiness reads.
 *
 * This door is light on purpose. `automation/event-source-health.ts` imports it
 * for `readInboundTriggerHealth`, so nothing here may reach the BullMQ queue or
 * the trigger bus. The receive path (the queue's producer) and the
 * `ingress.deliver` job body live in `../ingestion`, beside the queue they use;
 * the HTTP route imports `receiveInboundDelivery` from that door.
 */
export type {
  EventDeliveryHealth,
  EventDeliveryRecovery,
  InboundDedupRule,
  InboundKeyInput,
  InboundOwner,
  InboundProjection,
  InboundSourceDescriptor,
  InboundSubscriptionAdapter,
  InboundSyntheticKey,
} from "./descriptor";
export { inboundDeliveryKey } from "./descriptor";
export { INBOUND_SOURCES, inboundSource } from "./registry";
export { readInboundTriggerHealth } from "./health";
