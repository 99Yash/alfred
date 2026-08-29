import { briefings, type Briefing } from "@alfred/db/schemas";
import { and, asc, desc, eq, gte } from "drizzle-orm";
import { syncEntity } from "./sync-entity";

const BRIEFING_PULL_WINDOW_DAYS = 30;

export const fetchBriefings = syncEntity("briefing", {
  query: async (tx, userId) => {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - BRIEFING_PULL_WINDOW_DAYS);
    const cutoffDate = cutoff.toISOString().slice(0, 10);
    return tx
      .select()
      .from(briefings)
      .where(and(eq(briefings.userId, userId), gte(briefings.briefingDate, cutoffDate)))
      .orderBy(desc(briefings.briefingDate), asc(briefings.slot));
  },
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
