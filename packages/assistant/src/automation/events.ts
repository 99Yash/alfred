import { isInboundEventSource, toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { isDuplicateRunIndex, workflows } from "@alfred/db/schemas";
import { and, eq, or, sql } from "drizzle-orm";
import { uniqueViolationConstraint } from "@alfred/db/pg-errors";
import { startRun } from "@alfred/assistant/execution";

import {
  domainEventSchema,
  gmailMessagePayloadSchema,
  inboundDeliveryPayloadSchema,
  type DomainEvent,
} from "@alfred/assistant/triggers";

export interface AcceptEventResult {
  matched: number;
  created: number;
  skippedDuplicate: number;
  skippedNotAllowed: number;
  failed: number;
}

/** Event-trigger dispatcher (ADR-0047). Direct DB query and run creation; not the realtime outbox. */
export async function acceptEvent(input: DomainEvent): Promise<AcceptEventResult> {
  // Validate here too, so a direct caller cannot skip the contract.
  const args = domainEventSchema.parse(input);

  // Only `message_received` has a message payload. Parsing `documents_ingested` with it
  // would throw and fail the ingestion job.
  const gmailPayload =
    args.source === "gmail" && args.type === "message_received"
      ? gmailMessagePayloadSchema.parse(args.payload ?? {})
      : undefined;

  const reason = gmailPayload?.reason;
  const documentId = gmailPayload?.documentId;
  // Lets the outbound-reply re-eval (#282) skip triage's already-tagged guard.
  const force = gmailPayload?.force;

  // Inbound events carry a receipt pointer, not the body (ADR-0097). The run keeps it (#990).
  const receiptId = isInboundEventSource(args.source)
    ? inboundDeliveryPayloadSchema.parse(args.payload ?? {}).receiptId
    : undefined;

  const rows = await db()
    .select({
      id: workflows.id,
      slug: workflows.slug,
      allowedIntegrations: workflows.allowedIntegrations,
      publishedRevisionId: workflows.publishedRevisionId,
      isBuiltin: workflows.isBuiltin,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.userId, args.userId),
        eq(workflows.status, "active"),
        sql`${workflows.blocked} IS NULL`,
        sql`${workflows.trigger}->>'kind' = 'event'`,
        or(
          and(
            sql`${workflows.trigger}->>'source' = ${args.source}`,
            sql`${workflows.trigger}->>'type' = ${args.type}`,
            // Typed triggers and events both have no rawKind, so '' equals '' (#990).
            sql`coalesce(${workflows.trigger}->>'rawKind', '') = ${args.rawKind ?? ""}`,
            or(
              sql`${workflows.trigger}->>'accountRef' IS NULL`,
              args.accountRef
                ? sql`${workflows.trigger}->>'accountRef' = ${args.accountRef}`
                : sql`false`,
            ),
          ),
          legacyEventTriggerCondition(args),
        ),
      ),
    );

  const result: AcceptEventResult = {
    matched: rows.length,
    created: 0,
    skippedDuplicate: 0,
    skippedNotAllowed: 0,
    failed: 0,
  };

  await Promise.all(
    rows.map(async (row) => {
      try {
        if (row.allowedIntegrations.length > 0 && !row.allowedIntegrations.includes(args.source)) {
          result.skippedNotAllowed++;
          console.warn(
            `[workflows:event] skipping workflow=${row.slug}: source=${args.source} outside allowed_integrations`,
          );

          return;
        }

        if (!row.isBuiltin && !row.publishedRevisionId) {
          throw new Error(`[workflows:event] workflow=${row.slug} has no published revision`);
        }

        const workflowRevisionId = row.isBuiltin ? null : row.publishedRevisionId;

        let created: boolean;

        try {
          // A duplicate throws in the persist, before deliver, so the catch below still works.
          ({ created } = await startRun({
            userId: args.userId,
            workflowSlug: row.slug,
            workflowRevisionId,
            occurrence: {
              kind: "event",
              workflowId: row.id,
              provider: args.source,
              eventId: args.eventId,
            },
            input: {
              documentId,
              receiptId,
              reason,
              force,
              source: args.source,
              type: args.type,
              rawKind: args.rawKind,
              accountRef: args.accountRef,
            },
            metadata: {
              source: args.source,
              type: args.type,
              ...(args.rawKind !== undefined ? { rawKind: args.rawKind } : {}),
              eventId: args.eventId,
              ...(documentId !== undefined ? { documentId } : {}),
              ...(receiptId !== undefined ? { receiptId } : {}),
              ...(args.accountRef !== undefined ? { accountRef: args.accountRef } : {}),
            },
            trigger: {
              kind: "event",
              source: args.source,
              type: args.type,
              rawKind: args.rawKind,
              eventId: args.eventId,
              payload: { documentId, receiptId, reason, accountRef: args.accountRef },
            },
          }));
        } catch (err) {
          // A concurrent dispatch won the insert: count a duplicate, not a failure.
          // Either duplicate index can fire: the event identity index, or the dedup-key
          // index for a singleton workflow. Anything else rethrows.
          if (!isDuplicateRunIndex(uniqueViolationConstraint(err))) throw err;
          result.skippedDuplicate++;

          return;
        }

        if (created) result.created++;
        else result.skippedDuplicate++;
      } catch (err) {
        result.failed++;
        console.warn(
          `[workflows:event] failed for workflow=${row.slug} event=${args.source}.${args.type}:${args.eventId}:`,
          toMessage(err),
        );
      }
    }),
  );

  return result;
}

/**
 * Matches the pre-ADR-0047 triage trigger `source: 'gmail.ingest'` until the boot re-seed
 * rewrites it. Other sources have no legacy form and return `false`.
 */
function legacyEventTriggerCondition(args: DomainEvent) {
  if (args.source === "gmail" && args.type === "message_received") {
    return sql`${workflows.trigger}->>'source' = 'gmail.ingest'`;
  }

  return sql`false`;
}
