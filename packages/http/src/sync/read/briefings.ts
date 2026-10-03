import { briefings, type Briefing } from "@alfred/db/schemas";
import { SYNC_MODEL } from "@alfred/sync";
import { and, asc, desc, eq, gte, or, type SQL } from "drizzle-orm";
import { syncEntity } from "./sync-entity";

const BRIEFING_PULL_WINDOW_DAYS = 30;

// ADR-0049: one window, one owner, both query stages. `readAt` is the single
// instant this entity read started, so both stages agree on the cutoff even
// though they are two statements.
const inWindow = (userId: string, readAt: Date) => {
  const cutoff = new Date(readAt);
  cutoff.setUTCDate(cutoff.getUTCDate() - BRIEFING_PULL_WINDOW_DAYS);

  return and(
    eq(briefings.userId, userId),
    gte(briefings.briefingDate, cutoff.toISOString().slice(0, 10)),
  );
};

// A briefing's identity is `(briefingDate, slot)`, so a changed set restricts on
// exact pairs rather than a single id column.
const selected = (
  changed: readonly { briefingDate: string; slot: Briefing["slot"] }[],
): SQL | undefined =>
  or(
    ...changed.map((v) =>
      and(eq(briefings.briefingDate, v.briefingDate), eq(briefings.slot, v.slot)),
    ),
  );

export const fetchBriefings = syncEntity(SYNC_MODEL.briefing, {
  versionQuery: (tx, userId, readAt) =>
    tx
      .select({
        briefingDate: briefings.briefingDate,
        slot: briefings.slot,
        rowVersion: briefings.rowVersion,
      })
      .from(briefings)
      .where(inWindow(userId, readAt))
      .orderBy(desc(briefings.briefingDate), asc(briefings.slot)),
  loadQuery: (tx, userId, changed, readAt) =>
    tx
      .select()
      .from(briefings)
      .where(and(inWindow(userId, readAt), selected(changed)))
      .orderBy(desc(briefings.briefingDate), asc(briefings.slot)),
  map: (b: Briefing) => ({
    id: b.id,
    userId: b.userId,
    briefingDate: b.briefingDate,
    slot: b.slot,
    timezone: b.timezone,
    status: b.status,
    sendDecision: b.sendDecision,
    gateReason: b.gateReason,
    gather: b.gather,
    closedLoops: b.closedLoops,
    breakingSummary: b.breakingSummary,
    fullBriefing: b.fullBriefing,
    model: b.model,
    composeFallback: b.composeFallback,
    emailSendId: b.emailSendId,
    rowVersion: b.rowVersion,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  }),
});
