import { briefings, type Briefing } from "@alfred/db/schemas";
import { SYNC_MODEL } from "@alfred/sync";
import { and, asc, desc, eq, gte, or } from "drizzle-orm";
import { syncEntity } from "./sync-entity";

const BRIEFING_PULL_WINDOW_DAYS = 30;

// ADR-0049. The cutoff uses `readAt`, so both stages agree.
const inWindow = (userId: string, readAt: Date) => {
  const cutoff = new Date(readAt);
  cutoff.setUTCDate(cutoff.getUTCDate() - BRIEFING_PULL_WINDOW_DAYS);

  return and(
    eq(briefings.userId, userId),
    gte(briefings.briefingDate, cutoff.toISOString().slice(0, 10)),
  );
};

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
  // Identity is the pair `(briefingDate, slot)`, not one id column.
  loadQuery: (tx, userId, changed, readAt) =>
    tx
      .select()
      .from(briefings)
      .where(
        and(
          inWindow(userId, readAt),
          or(
            ...changed.map((v) =>
              and(eq(briefings.briefingDate, v.briefingDate), eq(briefings.slot, v.slot)),
            ),
          ),
        ),
      )
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
