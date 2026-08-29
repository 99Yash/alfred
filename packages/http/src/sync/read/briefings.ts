import { briefings, type Briefing } from "@alfred/db/schemas";
import { syncedBriefingSchema, type SyncedBriefing } from "@alfred/sync";
import { and, asc, desc, eq, gte } from "drizzle-orm";
import { defineFetcher } from "./define-fetcher";
import { defineSerializer } from "./define-serializer";

const BRIEFING_PULL_WINDOW_DAYS = 30;

const serializeBriefing = defineSerializer<Briefing, SyncedBriefing>(syncedBriefingSchema);

export const fetchBriefings = defineFetcher<Briefing>({
  slug: "BRIEFING",
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
  idOf: (b) => `${b.briefingDate}/${b.slot}`,
  versionOf: (b) => b.rowVersion,
  serialize: serializeBriefing,
});
