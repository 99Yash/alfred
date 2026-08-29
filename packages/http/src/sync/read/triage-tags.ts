import { TRIAGE_RAIL_SUPPRESSED_CATEGORIES } from "@alfred/contracts";
import { emailTriage, type EmailTriage } from "@alfred/db/schemas";
import { SYNC_MODEL } from "@alfred/sync";
import { and, asc, eq, gte, notInArray, or } from "drizzle-orm";
import { SerializationError } from "./entity-row";
import { syncEntity } from "./sync-entity";

/** Auto triage tags sync for this long after classification (rfc-triage-tags.md). */
const TRIAGE_TAG_WINDOW_DAYS = 30;

/**
 * Narrow a flat `email_triage` row to the `SyncedTriageTag` discriminated
 * union (rfc-triage-tags.md). The DB stores all columns flat (classifier
 * provenance is nullable, `overridden_at` is nullable); this is the single
 * point that refuses the contradiction — a `user` row drops confidence/
 * rationale/classifiedAt, an `auto` row drops overriddenAt. `zod` validates
 * the category string against `TRIAGE_CATEGORIES` on the way out.
 */
// rfc-triage-tags.md. `user` overrides always sync; `auto` tags sync within
// TRIAGE_TAG_WINDOW_DAYS and outside the rail-suppressed categories. Keyed by
// `source_thread_id` so the client store holds one tag per thread.
export const fetchTriageTags = syncEntity(SYNC_MODEL.triagetag, {
  query: (tx, userId) => {
    const cutoff = new Date(Date.now() - TRIAGE_TAG_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    return tx
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
  },
  map: (t: EmailTriage) => {
    const shared = {
      threadId: t.sourceThreadId,
      userId: t.userId,
      category: t.category,
      documentId: t.documentId,
      appliedLabelId: t.appliedLabelId,
      senderSignificanceBand: t.senderSignificanceBand,
      rowVersion: t.rowVersion,
      updatedAt: t.updatedAt,
    };
    if (t.source === "user") {
      if (!t.overriddenAt) {
        throw new SerializationError("emailTriage.overriddenAt must not be null");
      }
      return {
        source: "user" as const,
        overriddenAt: t.overriddenAt,
        ...shared,
      };
    }
    return {
      source: "auto" as const,
      confidence: t.confidence,
      rationale: t.rationale,
      classifiedAt: t.classifiedAt,
      ...shared,
    };
  },
});
