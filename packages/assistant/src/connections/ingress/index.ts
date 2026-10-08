/**
 * Inbound webhook descriptors and their subscription health (ADR-0097).
 * Keep it light: readiness and alerts import it, so it must not reach BullMQ or the trigger bus.
 * The receive path lives in `../ingestion`.
 */
export type {
  EventDeliveryCause,
  EventDeliveryFailure,
  EventDeliveryHealth,
  EventDeliveryRecovery,
  InboundAttribution,
  InboundDedupRule,
  InboundKeyInput,
  InboundOwner,
  InboundProjection,
  InboundSourceDescriptor,
  InboundSubscriptionAdapter,
  InboundSyntheticKey,
  UnattributedReference,
} from "./descriptor";

export { inboundDeliveryKey, projectionKind } from "./descriptor";

export { INBOUND_SOURCES, inboundSource } from "./registry";

export { readInboundTriggerHealth } from "./health";
