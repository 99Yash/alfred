import type { EventSource, EventType } from "@alfred/contracts";
import { isEventTypeForSource, toMessage } from "@alfred/contracts";
import { db } from "@alfred/db";
import { agentRuns, workflows } from "@alfred/db/schemas";
import { and, eq, or, sql } from "drizzle-orm";
import { enqueueRun } from "../agent/queue";
import { createRun } from "../agent/service";

export interface EmitEventArgs {
  userId: string;
  source: EventSource;
  type: EventType;
  eventId: string;
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
      slug: workflows.slug,
      allowedIntegrations: workflows.allowedIntegrations,
    })
    .from(workflows)
    .where(
      and(
        eq(workflows.userId, args.userId),
        eq(workflows.status, "active"),
        sql`${workflows.trigger}->>'kind' = 'event'`,
        or(
          and(
            sql`${workflows.trigger}->>'source' = ${args.source}`,
            sql`${workflows.trigger}->>'type' = ${args.type}`,
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

        const duplicate = await hasNonTerminalEventRun({
          userId: args.userId,
          workflowSlug: row.slug,
          source: args.source,
          type: args.type,
          eventId: args.eventId,
          reason,
        });
        if (duplicate) {
          result.skippedDuplicate++;
          return;
        }

        const { runId } = await createRun({
          userId: args.userId,
          workflowSlug: row.slug,
          input: { documentId, reason, force, source: args.source, type: args.type },
          metadata: { source: args.source, type: args.type, eventId: args.eventId, documentId },
          trigger: {
            kind: "event",
            source: args.source,
            type: args.type,
            eventId: args.eventId,
            payload: { documentId, reason },
          },
        });
        await enqueueRun(runId);
        result.created++;
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

async function hasNonTerminalEventRun(args: {
  userId: string;
  workflowSlug: string;
  source: EventSource;
  type: EventType;
  eventId: string;
  reason?: string;
}): Promise<boolean> {
  const rows = await db()
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.userId, args.userId),
        eq(agentRuns.workflowSlug, args.workflowSlug),
        sql`${agentRuns.status} NOT IN ('completed', 'failed', 'cancelled')`,
        sql`${agentRuns.trigger}->>'kind' = 'event'`,
        sql`${agentRuns.trigger}->>'source' = ${args.source}`,
        sql`${agentRuns.trigger}->>'type' = ${args.type}`,
        sql`${agentRuns.trigger}->>'eventId' = ${args.eventId}`,
        sql`coalesce(${agentRuns.trigger}->'payload'->>'reason', '') = ${args.reason ?? ""}`,
      ),
    )
    .limit(1);
  return Boolean(rows[0]);
}
