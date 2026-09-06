import { createHash } from "node:crypto";
import {
  eventTypeName,
  jsonObjectSchema,
  parseJsonWith,
  rawEventTypeName,
  toMessage,
  type InboundEventSource,
  type JsonObject,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { eventReceipts, type NewEventReceipt } from "@alfred/db/schemas";
import { and, eq } from "drizzle-orm";
import { inboundDeliveryKey, inboundSource, type InboundSourceDescriptor } from "../ingress";
import { enqueueInboundDelivery } from "./queue";

/**
 * Result of receiving one delivery on `POST /webhooks/inbound/:source`. The
 * HTTP route maps it to a status; nothing else about the wire lives there.
 *
 * - `unknown_source`: the `:source` segment is not an inbound source (404).
 * - `rejected`: the descriptor's `verify` refused the raw body (401).
 * - `ignored`: authenticated, but nothing to store — a ping, a body that is
 *   not a JSON object, a subscribed delivery whose payload lacks the identity
 *   its key reads (logged at error level: a payload path moved, which is a
 *   descriptor bug), or a delivery no credential owns. Acknowledged with 200 so
 *   the provider does not retry what cannot change.
 * - `duplicate`: a receipt for this dedup key already exists (either tier).
 * - `accepted`: a new typed receipt row exists and the delivery job is enqueued.
 * - `raw`: a new raw receipt row exists (ADR-0097 item 9); no job, no bus event.
 */
export type InboundDeliveryOutcome =
  | { kind: "unknown_source"; source: string }
  | { kind: "rejected"; source: InboundEventSource; reason: "invalid_signature" }
  | { kind: "ignored"; source: InboundEventSource; reason: string }
  | { kind: "duplicate"; source: InboundEventSource; receiptId: string }
  | { kind: "accepted"; source: InboundEventSource; receiptId: string; type: string }
  | { kind: "raw"; source: InboundEventSource; receiptId: string; rawKind: string };

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
 * Two tiers leave this function as a stored row. A delivery whose kind the
 * entry names is a typed receipt: declared dedup key, `pending`, one delivery
 * job, one bus event. A delivery whose kind the entry does not name is a raw
 * receipt (ADR-0097 item 9): keyed on the payload hash, `completed` at insert,
 * no job and no bus event, so nothing downstream of this function changes for
 * it. Both tiers share the verify, parse, and owner steps, so a raw row is
 * exactly as trusted and as attributed as a typed one.
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

  // Project before keying: the synthetic key switches on the projected type,
  // so a kind the entry does not name never reaches a key rule; it takes the
  // raw branch below instead. A `null` key after projection means one thing:
  // the payload lacks the identity the rule reads (a path that moved). That is
  // a descriptor bug and must be loud. It is still acknowledged: providers do
  // not redeliver on a 4xx, and a retry could not change the body.
  const projection = descriptor.project(payload, args.headers);
  if (projection.kind === "ignore") return { kind: "ignored", source, reason: projection.reason };

  const payloadHash = createHash("sha256").update(args.raw).digest("hex");
  if (projection.kind === "raw") {
    return storeRawReceipt({
      descriptor,
      source,
      payload,
      payloadHash,
      headers: args.headers,
      rawKind: projection.rawKind,
    });
  }

  const deliveryKey = inboundDeliveryKey(descriptor.dedup, args.headers, {
    payload,
    type: projection.type,
    payloadHash,
  });
  if (!deliveryKey) {
    console.error(
      `[ingress] ${source}: ${projection.type} payload carries no identity to key on; dropped`,
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
    payloadHash,
    payload,
    processingStatus: "pending",
  };
  const stored = await insertReceipt(row);
  switch (stored.kind) {
    case "inserted":
      await enqueueLogged(stored.id, source);
      return { kind: "accepted", source, receiptId: stored.id, type: projection.type };
    case "existing":
      if (stored.processingStatus !== "completed") {
        await enqueueLogged(stored.id, source);
      }
      return { kind: "duplicate", source, receiptId: stored.id };
    case "gone":
      return { kind: "ignored", source, reason: "receipt-gone" };
  }
}

/**
 * What one receipt insert settled to. `existing` carries the status so the
 * typed caller can re-enqueue a not-yet-completed duplicate; the raw caller
 * ignores it because a raw row is `completed` from birth.
 */
type ReceiptInsert =
  | { kind: "inserted"; id: string }
  | { kind: "existing"; id: string; processingStatus: string }
  /** The conflicting row vanished between the insert and the read-back (a cascade on credential deletion). */
  | { kind: "gone" };

/**
 * The one insert both tiers share: `onConflictDoNothing` on the
 * `(provider, provider_delivery_id)` unique index, then a read-back of the row
 * that won the conflict. The index is the dedup for both tiers, so the target
 * is named here and nowhere else.
 */
async function insertReceipt(row: NewEventReceipt): Promise<ReceiptInsert> {
  const inserted = await db()
    .insert(eventReceipts)
    .values(row)
    .onConflictDoNothing({ target: [eventReceipts.provider, eventReceipts.providerDeliveryId] })
    .returning({ id: eventReceipts.id });
  const insertedId = inserted[0]?.id;
  if (insertedId) return { kind: "inserted", id: insertedId };

  const [existing] = await db()
    .select({ id: eventReceipts.id, processingStatus: eventReceipts.processingStatus })
    .from(eventReceipts)
    .where(
      and(
        eq(eventReceipts.provider, row.provider),
        eq(eventReceipts.providerDeliveryId, row.providerDeliveryId),
      ),
    )
    .limit(1);
  return existing
    ? { kind: "existing", id: existing.id, processingStatus: existing.processingStatus }
    : { kind: "gone" };
}

/**
 * The raw tier (ADR-0097 item 9). The dedup key is the payload hash because a
 * kind the entry does not name has no declared identity rule: an exact provider
 * retry re-sends the bytes it queued and collapses onto the same row, while a
 * body the provider re-serialized differently lands twice. That duplicate is
 * accepted over the alternative, which is dropping a real event for good. The
 * row is `completed` at insert: the receipt is the whole processing, so no job
 * is enqueued and nothing is published; the deliver job's `completed` skip
 * makes a stray enqueue harmless too. The owner check is the same one the typed
 * tier runs, so an unattributable delivery is still acknowledged and dropped.
 */
async function storeRawReceipt(args: {
  descriptor: InboundSourceDescriptor;
  source: InboundEventSource;
  payload: JsonObject;
  payloadHash: string;
  headers: Headers;
  rawKind: string;
}): Promise<InboundDeliveryOutcome> {
  const { source, payloadHash, rawKind } = args;
  const owner = await args.descriptor.resolveOwner(args.payload, args.headers);
  if (!owner) {
    console.warn(`[ingress] ${source}: no owner for raw delivery ${rawKind}; dropped`);
    return { kind: "ignored", source, reason: "no-owner" };
  }

  const now = new Date();
  const row: NewEventReceipt = {
    provider: source,
    providerDeliveryId: payloadHash,
    credentialId: owner.credentialId,
    userId: owner.userId,
    eventType: rawEventTypeName(source),
    rawKind,
    verificationResult: INBOUND_VERIFICATION_RESULT,
    payloadHash,
    payload: args.payload,
    processingStatus: "completed",
    processedAt: now,
  };
  const stored = await insertReceipt(row);
  switch (stored.kind) {
    case "inserted":
      return { kind: "raw", source, receiptId: stored.id, rawKind };
    case "existing":
      return { kind: "duplicate", source, receiptId: stored.id };
    case "gone":
      return { kind: "ignored", source, reason: "receipt-gone" };
  }
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
