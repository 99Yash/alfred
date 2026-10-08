import { TRIAGE_RAIL_SUPPRESSED_CATEGORIES } from "@alfred/contracts";
import { emailTriage, type EmailTriage } from "@alfred/db/schemas";
import { SYNC_MODEL } from "@alfred/sync";
import { and, asc, eq, gte, inArray, notInArray, or } from "drizzle-orm";
import { SerializationError } from "./entity-row";
import { syncEntity } from "./sync-entity";

const TRIAGE_TAG_WINDOW_DAYS = 30;

// User overrides always sync; auto tags only inside the window and outside suppressed
// categories (rfc-triage-tags.md). The cutoff uses `readAt`, so both stages agree.
const syncsToClient = (userId: string, readAt: Date) => {
  const cutoff = new Date(readAt.getTime() - TRIAGE_TAG_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  return and(
    eq(emailTriage.userId, userId),
    or(
      eq(emailTriage.source, "user"),
      and(
        eq(emailTriage.source, "auto"),
        gte(emailTriage.classifiedAt, cutoff),
        notInArray(emailTriage.category, [...TRIAGE_RAIL_SUPPRESSED_CATEGORIES]),
      ),
    ),
  );
};

/** Narrow flat `email_triage` rows to the `SyncedTriageTag` union, one tag per thread. */
export const fetchTriageTags = syncEntity(SYNC_MODEL.triagetag, {
  versionQuery: (tx, userId, readAt) =>
    tx
      .select({ threadId: emailTriage.sourceThreadId, rowVersion: emailTriage.rowVersion })
      .from(emailTriage)
      .where(syncsToClient(userId, readAt))
      .orderBy(asc(emailTriage.sourceThreadId)),
  loadQuery: (tx, userId, changed, readAt) =>
    tx
      .select()
      .from(emailTriage)
      .where(
        and(
          syncsToClient(userId, readAt),
          inArray(
            emailTriage.sourceThreadId,
            changed.map((v) => v.threadId),
          ),
        ),
      )
      .orderBy(asc(emailTriage.sourceThreadId)),
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
