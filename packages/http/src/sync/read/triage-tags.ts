import { TRIAGE_RAIL_SUPPRESSED_CATEGORIES } from "@alfred/contracts";
import { emailTriage, type EmailTriage } from "@alfred/db/schemas";
import { syncedTriageTagSchema, type SyncedTriageTag } from "@alfred/sync";
import { and, asc, eq, gte, notInArray, or } from "drizzle-orm";
import { toEntityRow, type EntityFetcher } from "./entity-row";
import { toIso, toRequiredIso } from "./iso-date";

/** Auto triage tags sync for this long after classification (rfc-triage-tags.md). */
const TRIAGE_TAG_WINDOW_DAYS = 30;

// rfc-triage-tags.md. `user` overrides always sync; `auto` tags sync within
// TRIAGE_TAG_WINDOW_DAYS and outside the rail-suppressed categories. Keyed by
// `source_thread_id` so the client store holds one tag per thread.
export const fetchTriageTags: EntityFetcher = async (tx, userId) => {
  const cutoff = new Date(Date.now() - TRIAGE_TAG_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const rows = await tx
    .select()
    .from(emailTriage)
    .where(
      and(
        eq(emailTriage.userId, userId),
        or(
          eq(emailTriage.source, "user"),
          and(
            eq(emailTriage.source, "auto"),
            gte(emailTriage.classifiedAt, cutoff),
            notInArray(emailTriage.category, [...TRIAGE_RAIL_SUPPRESSED_CATEGORIES]),
          ),
        ),
      ),
    )
    .orderBy(asc(emailTriage.sourceThreadId));
  return rows.flatMap((r: EmailTriage) =>
    toEntityRow({
      slug: "TRIAGE_TAG",
      id: r.sourceThreadId,
      rowVersion: r.rowVersion,
      serialize: () => serializeTriageTag(r),
    }),
  );
};

/**
 * Narrow a flat `email_triage` row to the `SyncedTriageTag` discriminated
 * union (rfc-triage-tags.md). The DB stores all columns flat (classifier
 * provenance is nullable, `overridden_at` is nullable); this is the single
 * point that refuses the contradiction — a `user` row drops confidence/
 * rationale/classifiedAt, an `auto` row drops overriddenAt. `zod` validates
 * the category string against `TRIAGE_CATEGORIES` on the way out.
 */
function serializeTriageTag(t: EmailTriage): SyncedTriageTag {
  const shared = {
    threadId: t.sourceThreadId,
    userId: t.userId,
    category: t.category,
    documentId: t.documentId,
    appliedLabelId: t.appliedLabelId,
    senderSignificanceBand: t.senderSignificanceBand,
    rowVersion: t.rowVersion,
    updatedAt: toIso(t.updatedAt),
  };
  if (t.source === "user") {
    return syncedTriageTagSchema.parse({
      source: "user",
      overriddenAt: toRequiredIso(t.overriddenAt, "emailTriage.overriddenAt"),
      ...shared,
    });
  }
  return syncedTriageTagSchema.parse({
    source: "auto",
    confidence: t.confidence,
    rationale: t.rationale,
    classifiedAt: toRequiredIso(t.classifiedAt, "emailTriage.classifiedAt"),
    ...shared,
  });
}
