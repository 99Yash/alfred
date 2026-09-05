import { createHash } from "node:crypto";
import {
  eventTypeName,
  jsonObjectSchema,
  parseJsonWith,
  toMessage,
  type InboundEventSource,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { eventReceipts, type NewEventReceipt } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";
import { inboundDeliveryKey, inboundSource } from "../ingress";
import { enqueueInboundDelivery } from "./queue";

/**
 * Result of receiving one delivery on `POST /webhooks/inbound/:source`. The
 * HTTP route maps it to a status; nothing else about the wire lives there.
 *
 * - `unknown_source`: the `:source` segment is not an inbound source (404).
 * - `rejected`: the descriptor's `verify` refused the raw body (401).
 * - `ignored`: authenticated, but nothing to store — a ping, an unsubscribed
 *   event, a body that is not a JSON object, a subscribed delivery the dedup
 *   rule cannot key (logged at error level: that is a descriptor bug), or a
 *   delivery no credential owns. Acknowledged with 200 so the provider does
 *   not retry what cannot change.
 * - `duplicate`: a receipt for this dedup key already exists.
 * - `accepted`: a new receipt row exists and the delivery job is enqueued.
 */
export type InboundDeliveryOutcome =
  | { kind: "unknown_source"; source: string }
  | { kind: "rejected"; source: InboundEventSource; reason: "invalid_signature" }
  | { kind: "ignored"; source: InboundEventSource; reason: string }
  | { kind: "duplicate"; source: InboundEventSource; receiptId: string }
  | { kind: "accepted"; source: InboundEventSource; receiptId: string; type: string };

/** The one `verification_result` value a stored inbound receipt can carry: unverified bodies are never stored. */
export const INBOUND_VERIFICATION_RESULT = "signature_valid";

export interface ReceiveInboundDeliveryArgs {
  /** The route's `:source` segment, unvalidated. */
  source: string;
  /** The exact request bytes, for the descriptor's signature check and the audit hash. */
  raw: string;
  headers: Headers;
}

/**
 * The shared receive path every inbound source runs through (ADR-0097):
 * look up the descriptor, verify the RAW body, parse, project, key, attribute,
 * persist one `event_receipts` row with `onConflictDoNothing`, then enqueue
 * `ingress.deliver`. The request is acknowledged as soon as the row exists; no
 * workflow runs inline.
 *
 * This is the queue's producer, so it lives beside the queue rather than in
 * `../ingress`: that door is on the automation readiness import path and must
 * stay free of BullMQ and the Gmail ingestion graph.
 *
 * The crash window between the insert and the enqueue is closed on the next
 * redelivery: a duplicate whose receipt is not yet `completed` is enqueued
 * again. `enqueueInboundDelivery` owns what makes that safe.
 */
export async function receiveInboundDelivery(
  args: ReceiveInboundDeliveryArgs,
): Promise<InboundDeliveryOutcome> {
  const descriptor = inboundSource(args.source);
  if (!descriptor) return { kind: "unknown_source", source: args.source };
  const source = descriptor.slug;

  if (!(await descriptor.verify(args.raw, args.headers))) {
    console.warn(`[ingress] ${source}: signature verification failed`);
    return { kind: "rejected", source, reason: "invalid_signature" };
  }

  const payload = parseJsonWith(args.raw, jsonObjectSchema);
  if (!payload) return { kind: "ignored", source, reason: "bad-json" };

  // Project before keying: an event the source does not subscribe to is
  // dropped quietly, but a subscribed event the dedup rule cannot key is a
  // descriptor bug (a payload path that moved), and must be loud. It is still
  // acknowledged: providers do not redeliver on a 4xx, and a retry could not
  // change the body.
  const projection = descriptor.project(payload, args.headers);
  if (projection.kind === "ignore") return { kind: "ignored", source, reason: projection.reason };

  const deliveryKey = inboundDeliveryKey(descriptor.dedup, payload, args.headers);
  if (!deliveryKey) {
    console.error(
      `[ingress] ${source}: no dedup key for subscribed event ${projection.type}; dropped`,
    );
    return { kind: "ignored", source, reason: "no-dedup-key" };
  }

  const owner = await descriptor.resolveOwner(payload, args.headers);
  if (!owner) {
    // A delivery for an account nobody connected (or mid-disconnect) has no
    // row to hang off `credential_id`; ack it so the provider stops retrying.
    console.warn(`[ingress] ${source}: no owner for delivery ${deliveryKey}; dropped`);
    return { kind: "ignored", source, reason: "no-owner" };
  }

  const row: NewEventReceipt = {
    provider: source,
    providerDeliveryId: deliveryKey,
    credentialId: owner.credentialId,
    userId: owner.userId,
    eventType: eventTypeName(source, projection.type),
    verificationResult: INBOUND_VERIFICATION_RESULT,
    payloadHash: createHash("sha256").update(args.raw).digest("hex"),
    payload,
    processingStatus: "pending",
  };
  const inserted = await db()
    .insert(eventReceipts)
    .values(row)
    .onConflictDoNothing({ target: [eventReceipts.provider, eventReceipts.providerDeliveryId] })
    .returning({ id: eventReceipts.id });

  const receiptId = inserted[0]?.id;
  if (receiptId) {
    await enqueueLogged(receiptId, source);
    return { kind: "accepted", source, receiptId, type: projection.type };
  }

  const [existing] = await db()
    .select({ id: eventReceipts.id, processingStatus: eventReceipts.processingStatus })
    .from(eventReceipts)
    .where(
      and(eq(eventReceipts.provider, source), eq(eventReceipts.providerDeliveryId, deliveryKey)),
    )
    .limit(1);
  if (!existing) {
    // The conflicting row vanished between the insert and this read (a cascade
    // on credential deletion). Nothing to deliver.
    return { kind: "ignored", source, reason: "receipt-gone" };
  }
  if (existing.processingStatus !== "completed") {
    await enqueueLogged(existing.id, source);
  }
  return { kind: "duplicate", source, receiptId: existing.id };
}

async function enqueueLogged(receiptId: string, source: InboundEventSource): Promise<void> {
  try {
    await enqueueInboundDelivery(receiptId);
  } catch (error) {
    // The receipt is durable; the next redelivery re-enqueues it. Failing the
    // request here would make the provider retry a body we already stored.
    console.error(`[ingress] ${source}: enqueue failed for receipt ${receiptId}`, toMessage(error));
  }
}
