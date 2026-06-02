import type { BriefingGather, BriefingStatus, FullBriefing, IanaTimezone } from "@alfred/contracts";
import { db } from "@alfred/db";
import { briefings } from "@alfred/db/schemas";
import { and, eq, sql } from "drizzle-orm";

export interface BriefingRow {
  id: string;
  userId: string;
  briefingDate: string;
  timezone: IanaTimezone;
  status: BriefingStatus;
  gather: BriefingGather | null;
  breakingSummary: string | null;
  fullBriefing: FullBriefing | null;
  model: string | null;
  composeFallback: boolean;
  emailSendId: string | null;
  rowVersion: number;
}

export type BeginBriefingResult =
  | { action: "created"; row: BriefingRow }
  | { action: "retry"; row: BriefingRow }
  | { action: "skip_sent"; row: BriefingRow }
  | { action: "resume"; row: BriefingRow };

export async function beginBriefing(args: {
  userId: string;
  briefingDate: string;
  timezone: IanaTimezone;
}): Promise<BeginBriefingResult> {
  const inserted = await db()
    .insert(briefings)
    .values({
      userId: args.userId,
      briefingDate: args.briefingDate,
      timezone: args.timezone,
      status: "pending",
    })
    .onConflictDoNothing({
      target: [briefings.userId, briefings.briefingDate],
    })
    .returning();

  const insertedRow = inserted[0];
  if (insertedRow) return { action: "created", row: rowToBriefing(insertedRow) };

  const existing = await getBriefingByUserDate(args.userId, args.briefingDate);
  if (!existing) {
    throw new Error(
      `[briefing.store] conflict path found no row user=${args.userId} date=${args.briefingDate}`,
    );
  }

  if (existing.status === "sent") return { action: "skip_sent", row: existing };
  if (existing.status === "failed") {
    const retry = await updateBriefing(existing.id, {
      status: "pending",
      timezone: args.timezone,
      gather: null,
      breakingSummary: null,
      fullBriefing: null,
      model: null,
      composeFallback: false,
      emailSendId: null,
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
}): Promise<BriefingRow> {
  return updateBriefing(args.briefingId, {
    status: "sent",
    emailSendId: args.emailSendId,
  });
}

export async function markBriefingFailed(briefingId: string): Promise<BriefingRow> {
  return updateBriefing(briefingId, {
    status: "failed",
  });
}

async function getBriefingByUserDate(
  userId: string,
  briefingDate: string,
): Promise<BriefingRow | null> {
  const rows = await db()
    .select()
    .from(briefings)
    .where(and(eq(briefings.userId, userId), eq(briefings.briefingDate, briefingDate)))
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
    timezone: row.timezone,
    status: row.status,
    gather: row.gather ?? null,
    breakingSummary: row.breakingSummary,
    fullBriefing: row.fullBriefing ?? null,
    model: row.model,
    composeFallback: row.composeFallback,
    emailSendId: row.emailSendId,
    rowVersion: row.rowVersion,
  };
}
