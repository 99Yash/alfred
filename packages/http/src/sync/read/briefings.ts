import { briefings, type Briefing } from "@alfred/db/schemas";
import { and, asc, desc, eq, gte } from "drizzle-orm";
import { syncEntity } from "./sync-entity";

const BRIEFING_PULL_WINDOW_DAYS = 30;

export const fetchBriefings = syncEntity<"BRIEFING", Briefing>("BRIEFING", {
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
  map: (b) => b,
});
