import { briefings, type Briefing } from "@alfred/db/schemas";
import { syncedBriefingSchema, type SyncedBriefing } from "@alfred/sync";
import { and, asc, desc, eq, gte } from "drizzle-orm";
import { toEntityRow, type EntityFetcher } from "./entity-row";
import { toIso, toRequiredIso } from "./iso-date";

const BRIEFING_PULL_WINDOW_DAYS = 30;

export const fetchBriefings: EntityFetcher = async (tx, userId) => {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - BRIEFING_PULL_WINDOW_DAYS);
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  const rows = await tx
    .select()
    .from(briefings)
    .where(and(eq(briefings.userId, userId), gte(briefings.briefingDate, cutoffDate)))
    .orderBy(desc(briefings.briefingDate), asc(briefings.slot));
  return rows.flatMap((b: Briefing) =>
    toEntityRow({
      slug: "BRIEFING",
      id: `${b.briefingDate}/${b.slot}`,
      rowVersion: b.rowVersion,
      serialize: () => serializeBriefing(b),
    }),
  );
};

function serializeBriefing(b: Briefing): SyncedBriefing {
  return syncedBriefingSchema.parse({
    id: b.id,
    userId: b.userId,
    briefingDate: b.briefingDate,
    slot: b.slot,
    timezone: b.timezone,
    status: b.status,
    sendDecision: b.sendDecision ?? null,
    gateReason: b.gateReason,
    gather: b.gather ?? null,
    breakingSummary: b.breakingSummary,
    fullBriefing: b.fullBriefing ?? null,
    model: b.model,
    composeFallback: b.composeFallback,
    emailSendId: b.emailSendId,
    rowVersion: b.rowVersion,
    createdAt: toRequiredIso(b.createdAt, "briefings.createdAt"),
    updatedAt: toIso(b.updatedAt),
  });
}
