import type { EventSource, EventType } from "@alfred/contracts";
import { isEventTypeForSource, toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { isDuplicateRunIndex, workflows } from "@alfred/db/schemas";
import { and, eq, or, sql } from "drizzle-orm";
import { uniqueViolationConstraint } from "../../lib/pg-errors";
import { enqueueRun } from "../agent/queue";
import { createRun } from "../agent/service";
import { workflowOccurrenceKey } from "./occurrence";

export interface EmitEventArgs {
  userId: string;
  source: EventSource;
  type: EventType;
  eventId: string;
  /** Provider account that produced the event, for account-bound user workflows. */
  accountRef?: string;
  payload?: Record<string, unknown>;
}

export interface EmitEventResult {
  matched: number;
  created: number;
  skippedDuplicate: number;
  skippedNotAllowed: number;
  failed: number;
}

/**
 * Generic event-trigger dispatcher (ADR-0047).
 *
 * This is intentionally a direct DB query + run creation path, not the
 * realtime outbox/SSE event bus under `modules/events`.
 */
export async function emitEvent(args: EmitEventArgs): Promise<EmitEventResult> {
  if (!isEventTypeForSource(args.source, args.type)) {
    throw new Error(`[workflows:event] type='${args.type}' is invalid for source='${args.source}'`);
  }

  const reason = typeof args.payload?.reason === "string" ? args.payload.reason : undefined;
  const documentId =
    typeof args.payload?.documentId === "string" ? args.payload.documentId : undefined;
  // Threaded into the run input so a re-key on an already-classified doc (the
  // outbound-reply re-eval, issue #282) bypasses the triage already-tagged
  // skip guard instead of no-op'ing.
  const force = typeof args.payload?.force === "boolean" ? args.payload.force : undefined;

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

  const result: EmitEventResult = {
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

        let runId: string;
        let created: boolean;
        try {
          ({ runId, created } = await createRun({
            userId: args.userId,
            workflowSlug: row.slug,
            workflowRevisionId,
            occurrenceKey: workflowOccurrenceKey({
              kind: "event",
              workflowId: row.id,
              provider: args.source,
              eventId: args.eventId,
              ...(reason ? { reason } : {}),
            }),
            input: {
              documentId,
              reason,
              force,
              source: args.source,
              type: args.type,
              accountRef: args.accountRef,
            },
            metadata: {
              source: args.source,
              type: args.type,
              eventId: args.eventId,
              documentId,
              accountRef: args.accountRef,
            },
            trigger: {
              kind: "event",
              source: args.source,
              type: args.type,
              eventId: args.eventId,
              payload: { documentId, reason, accountRef: args.accountRef },
            },
          }));
        } catch (err) {
          // The concurrent dispatch that beat us to the insert owns this event.
          // Nothing was created, so drop it as a duplicate rather than a
          // failure — the same outcome the fast path above reports.
          //
          // Either duplicate-run index can be the one that fires: the event
          // identity index normally, or the general dedup-key index when the
          // target workflow also declares a `dedupKey` (a singleton like
          // cold-start-research). Both mean "already exists"; matching only the
          // first counted the second as a failure and logged an error for a
          // benign drop. Anything else really is a fault and rethrows.
          if (!isDuplicateRunIndex(uniqueViolationConstraint(err))) throw err;
          result.skippedDuplicate++;
          return;
        }
        await enqueueRun(runId);
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
 * Bridges the brief deploy-window gap between this code shipping and the
 * seeder re-writing builtin triggers to the new `{ source, type }` shape
 * (ADR-0047). Only the legacy triage trigger (`source: 'gmail.ingest'`) needs
 * this; any future event source must add its own mapping here, otherwise it
 * falls through to `false` (no legacy form to match).
 */
function legacyEventTriggerCondition(args: EmitEventArgs) {
  if (args.source === "gmail" && args.type === "message_received") {
    return sql`${workflows.trigger}->>'source' = 'gmail.ingest'`;
  }
  return sql`false`;
}
