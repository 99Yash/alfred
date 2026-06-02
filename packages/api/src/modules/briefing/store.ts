import type {
  BriefingGather,
  BriefingSendDecision,
  BriefingSlot,
  BriefingStatus,
  FullBriefing,
  IanaTimezone,
} from "@alfred/contracts";
import { db } from "@alfred/db";
import { briefings } from "@alfred/db/schemas";
import { and, eq, sql } from "drizzle-orm";

export interface BriefingRow {
  id: string;
  userId: string;
  briefingDate: string;
  slot: BriefingSlot;
  timezone: IanaTimezone;
  status: BriefingStatus;
  watermarkAt: Date | null;
  gather: BriefingGather | null;
  breakingSummary: string | null;
  fullBriefing: FullBriefing | null;
  model: string | null;
  composeFallback: boolean;
  sendDecision: BriefingSendDecision | null;
  gateReason: string | null;
  emailSendId: string | null;
  agentRunId: string | null;
  rowVersion: number;
}

export type BeginBriefingResult =
  | { action: "created"; row: BriefingRow }
  | { action: "retry"; row: BriefingRow }
  | { action: "skip_terminal"; row: BriefingRow }
  | { action: "resume"; row: BriefingRow };

export async function beginBriefing(args: {
  userId: string;
  briefingDate: string;
  slot: BriefingSlot;
  timezone: IanaTimezone;
  agentRunId?: string;
}): Promise<BeginBriefingResult> {
  const inserted = await db()
    .insert(briefings)
    .values({
      userId: args.userId,
      briefingDate: args.briefingDate,
      slot: args.slot,
      timezone: args.timezone,
      status: "pending",
      agentRunId: args.agentRunId,
    })
    .onConflictDoNothing({
      target: [briefings.userId, briefings.briefingDate, briefings.slot],
    })
    .returning();

  const insertedRow = inserted[0];
  if (insertedRow) return { action: "created", row: rowToBriefing(insertedRow) };

  const existing = await getBriefingByUserDateSlot(args.userId, args.briefingDate, args.slot);
  if (!existing) {
    throw new Error(
      `[briefing.store] conflict path found no row user=${args.userId} date=${args.briefingDate} slot=${args.slot}`,
    );
  }

  if (existing.status === "sent" || existing.status === "suppressed") {
    return { action: "skip_terminal", row: existing };
  }
  if (existing.status === "failed") {
    const retry = await updateBriefing(existing.id, {
      status: "pending",
      timezone: args.timezone,
      watermarkAt: null,
      gather: null,
      breakingSummary: null,
      fullBriefing: null,
      model: null,
      composeFallback: false,
      sendDecision: null,
      gateReason: null,
      emailSendId: null,
      agentRunId: args.agentRunId,
    });
    return { action: "retry", row: retry };
  }

  return { action: "resume", row: existing };
}

export async function markBriefingGathering(args: {
  briefingId: string;
  gather: BriefingGather;
}): Promise<BriefingRow> {
  return updateBriefing(args.briefingId, {
    status: "gathering",
    gather: args.gather,
  });
}

export async function markBriefingComposing(briefingId: string): Promise<BriefingRow> {
  return updateBriefing(briefingId, {
    status: "composing",
  });
}

export async function markBriefingComposed(args: {
  briefingId: string;
  breakingSummary: string;
  fullBriefing: FullBriefing;
  model: string;
  composeFallback: boolean;
}): Promise<BriefingRow> {
  return updateBriefing(args.briefingId, {
    status: "composed",
    breakingSummary: args.breakingSummary,
    fullBriefing: args.fullBriefing,
    model: args.model,
    composeFallback: args.composeFallback,
  });
}

export async function markBriefingSent(args: {
  briefingId: string;
  emailSendId: string | null;
  watermarkAt: Date;
  gateReason?: string | null;
}): Promise<BriefingRow> {
  return updateBriefing(args.briefingId, {
    status: "sent",
    watermarkAt: args.watermarkAt,
    sendDecision: "sent",
    gateReason: args.gateReason ?? null,
    emailSendId: args.emailSendId,
  });
}

export async function markBriefingSuppressed(args: {
  briefingId: string;
  watermarkAt: Date;
  gateReason: string;
}): Promise<BriefingRow> {
  return updateBriefing(args.briefingId, {
    status: "suppressed",
    watermarkAt: args.watermarkAt,
    sendDecision: "suppressed",
    gateReason: args.gateReason,
    emailSendId: null,
  });
}

export async function markBriefingFailed(briefingId: string): Promise<BriefingRow> {
  return updateBriefing(briefingId, {
    status: "failed",
  });
}

async function getBriefingByUserDateSlot(
  userId: string,
  briefingDate: string,
  slot: BriefingSlot,
): Promise<BriefingRow | null> {
  const rows = await db()
    .select()
    .from(briefings)
    .where(
      and(
        eq(briefings.userId, userId),
        eq(briefings.briefingDate, briefingDate),
        eq(briefings.slot, slot),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row ? rowToBriefing(row) : null;
}

async function updateBriefing(
  briefingId: string,
  set: Partial<typeof briefings.$inferInsert>,
): Promise<BriefingRow> {
  const rows = await db()
    .update(briefings)
    .set({
      ...set,
      rowVersion: sql`${briefings.rowVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(briefings.id, briefingId))
    .returning();
  const row = rows[0];
  if (!row) throw new Error(`[briefing.store] update returned no row id=${briefingId}`);
  return rowToBriefing(row);
}

function rowToBriefing(row: typeof briefings.$inferSelect): BriefingRow {
  return {
    id: row.id,
    userId: row.userId,
    briefingDate: row.briefingDate,
    slot: row.slot,
    timezone: row.timezone,
    status: row.status,
    watermarkAt: row.watermarkAt,
    gather: row.gather ?? null,
    breakingSummary: row.breakingSummary,
    fullBriefing: row.fullBriefing ?? null,
    model: row.model,
    composeFallback: row.composeFallback,
    sendDecision: row.sendDecision ?? null,
    gateReason: row.gateReason,
    emailSendId: row.emailSendId,
    agentRunId: row.agentRunId,
    rowVersion: row.rowVersion,
  };
}
