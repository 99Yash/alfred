import { createHash } from "node:crypto";
import {
  eventTypeName,
  jsonObjectSchema,
  parseJsonWith,
  rawEventTypeName,
  toMessage,
  type InboundEventSource,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { eventReceipts, type EventReceipt, type NewEventReceipt } from "@alfred/db/schemas";
import { report } from "@alfred/logging/report";
import { and, eq } from "drizzle-orm";
import {
  inboundDeliveryKey,
  inboundSource,
  projectionKind,
  type InboundAttribution,
  type InboundKeyInput,
  type InboundOwner,
  type InboundProjection,
} from "../ingress";
import { enqueueInboundDelivery } from "./queue";
import { prepareReceiptProjection, writeReceiptDocument } from "./receipt-document";

/**
 * Result of one `POST /webhooks/inbound/:source` delivery. The route maps it to a status.
 * - `unknown_source`: 404. `rejected`: signature refused, 401.
 * - `ignored`: authenticated but not stored (ping, non-object body, missing key identity, or no
 *   owning credential). Acked with 200 so the provider does not retry.
 * - `duplicate`: a receipt with this dedup key exists in either tier.
 * - `accepted`: new typed receipt, delivery job enqueued.
 * - `raw`: new raw receipt (ADR-0097 items 9 and 11), same delivery job.
 */
export type InboundDeliveryOutcome =
  | { kind: "unknown_source"; source: string }
  | { kind: "rejected"; source: InboundEventSource; reason: "invalid_signature" }
  | { kind: "ignored"; source: InboundEventSource; reason: string }
  | { kind: "duplicate"; source: InboundEventSource; receiptId: string }
  | { kind: "accepted"; source: InboundEventSource; receiptId: string; type: string }
  | { kind: "raw"; source: InboundEventSource; receiptId: string; rawKind: string };

/** Unverified bodies are never stored, so this is the only value. */
export const INBOUND_VERIFICATION_RESULT = "signature_valid";

export interface ReceiveInboundDeliveryArgs {
  /** The route's `:source` segment, unvalidated. */
  source: string;
  /** Exact request bytes, for the signature check and the audit hash. */
  raw: string;
  headers: Headers;
}

/**
 * Shared receive path for every inbound source (ADR-0097): verify the raw body, parse, project,
 * attribute, key, insert one `event_receipts` row, then enqueue `ingress.deliver`. A kind the entry
 * names is a typed receipt. Any other kind is a raw receipt keyed on kind and payload hash,
 * published as `<source>.raw` (#990). Both tiers share verify and owner steps. Lives here, not in
 * `../ingress`, which must stay free of BullMQ. A crash between insert and enqueue heals on
 * redelivery: a non-completed duplicate is re-enqueued.
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

  // Project before keying, so an unnamed kind takes the raw branch. A `null` key after that means a
  // payload path moved: a descriptor bug, so log loudly but still ack.
  const projection = descriptor.project(payload, args.headers);

  if (projection.kind === "ignore") return { kind: "ignored", source, reason: projection.reason };

  const attribution = await descriptor.resolveOwner(payload, args.headers);

  if (attribution.kind === "unowned") {
    // #1209: GitHub sends kinds no installation owns (security_advisory), which flooded Sentry.
    // Drop those silently. For other sources it is still a bug worth reporting.
    if (source !== "github") reportOwnerlessDelivery(source, projection, attribution);

    return { kind: "ignored", source, reason: "no-owner" };
  }

  const { owner } = attribution;

  const payloadHash = createHash("sha256").update(args.raw).digest("hex");
  const receipt = { source, owner, payload, payloadHash };

  if (projection.kind === "raw") {
    const stored = await insertReceipt({ ...receipt, tier: projection });

    switch (stored.kind) {
      case "inserted":
        await enqueueLogged(stored.id, source);

        return { kind: "raw", source, receiptId: stored.id, rawKind: projection.rawKind };
      case "existing":
        if (stored.processingStatus !== "completed") {
          await enqueueLogged(stored.id, source);
        }

        return { kind: "duplicate", source, receiptId: stored.id };
      case "gone":
        return { kind: "ignored", source, reason: "receipt-gone" };
    }
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

  const stored = await insertReceipt({
    ...receipt,
    tier: { ...projection, deliveryKey },
  });

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
 * Report an unattributable delivery (#1033). The drop itself stays (ADR-0097 alternative (e)):
 * `credential_id` is `NOT NULL` and a retry cannot change the body. Tags carry the provider
 * reference under its credential column, to tell "no credential" from "credential for another
 * account". Never the payload: unbounded, unknown sensitivity. `warning`, not `error`:
 * `installation.created` can arrive before the connect flow stores its credential.
 */
function reportOwnerlessDelivery(
  source: InboundEventSource,
  projection: Exclude<InboundProjection<InboundEventSource>, { kind: "ignore" }>,
  attribution: Extract<InboundAttribution, { kind: "unowned" }>,
): void {
  const kind = projectionKind(projection);
  const { reason, reference } = attribution;
  report({
    event: "ingress.no_owner",
    message: "a verified inbound delivery matched no active credential and was dropped",
    level: "warning",
    tags: {
      source,
      kind,
      reason,
      ...(reference ? { [reference.column]: reference.value } : {}),
    },
    dimensions: [source, kind],
  });
}

/** `existing` carries the status so the caller can re-enqueue a non-completed duplicate. */
type ReceiptInsert =
  | { kind: "inserted"; id: string }
  | ({ kind: "existing" } & Pick<EventReceipt, "id" | "processingStatus">)
  /** The row vanished before the read-back (credential deletion cascade). */
  | { kind: "gone" };

/** Insert for both tiers. The `(provider, provider_delivery_id)` unique index is the only dedup. */
async function insertReceipt(
  args: Pick<InboundKeyInput, "payload" | "payloadHash"> & {
    source: InboundEventSource;
    owner: InboundOwner;
    tier:
      | (Extract<InboundProjection<InboundEventSource>, { kind: "event" }> & {
          deliveryKey: string;
        })
      | Extract<InboundProjection<InboundEventSource>, { kind: "raw" }>;
  },
): Promise<ReceiptInsert> {
  const { source, owner, tier } = args;

  const row: NewEventReceipt = {
    provider: source,
    credentialId: owner.credentialId,
    userId: owner.userId,
    verificationResult: INBOUND_VERIFICATION_RESULT,
    payloadHash: args.payloadHash,
    payload: args.payload,
    processingStatus: "pending",
    ...(tier.kind === "raw"
      ? {
          providerDeliveryId: `raw:${tier.rawKind}:${args.payloadHash}`,
          eventType: rawEventTypeName(source),
          rawKind: tier.rawKind,
        }
      : {
          providerDeliveryId: tier.deliveryKey,
          eventType: eventTypeName(source, tier.type),
        }),
  };

  const projection = await prepareReceiptProjection({
    provider: source,
    userId: owner.userId,
    eventType: row.eventType,
    rawKind: row.rawKind ?? null,
  });

  const insertedId = await db().transaction(async (tx) => {
    const [inserted] = await tx
      .insert(eventReceipts)
      .values(row)
      .onConflictDoNothing({ target: [eventReceipts.provider, eventReceipts.providerDeliveryId] })
      .returning({ id: eventReceipts.id, deliveredAt: eventReceipts.deliveredAt });

    if (!inserted) return null;
    await writeReceiptDocument(tx, projection, {
      id: inserted.id,
      payload: args.payload,
      deliveredAt: inserted.deliveredAt,
      accountId: owner.accountRef,
    });

    return inserted.id;
  });

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

async function enqueueLogged(receiptId: string, source: InboundEventSource): Promise<void> {
  try {
    await enqueueInboundDelivery(receiptId);
  } catch (error) {
    // The receipt is durable and redelivery re-enqueues it. Failing would make the provider resend.
    console.error(`[ingress] ${source}: enqueue failed for receipt ${receiptId}`, toMessage(error));
  }
}
