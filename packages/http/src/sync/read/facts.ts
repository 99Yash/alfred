import { isUninformativeRelationshipFact } from "@alfred/assistant/knowledge";
import { userFacts, type UserFact } from "@alfred/db/schemas";
import { factValueSchema, syncedFactSchema } from "@alfred/sync";
import { and, asc, eq, inArray } from "drizzle-orm";
import { SerializationError } from "./entity-row";
import { syncEntity } from "./sync-entity";

// Only `proposed` + `confirmed` reach the client; rejected / edited /
// superseded rows stay server-side as audit history.
export const fetchFacts = syncEntity("FACT", {
  query: async (tx, userId) => {
    const rows: UserFact[] = await tx
      .select()
      .from(userFacts)
      .where(
        and(eq(userFacts.userId, userId), inArray(userFacts.status, ["proposed", "confirmed"])),
      )
      .orderBy(asc(userFacts.id));
    // #491: a proposed `relationship:<email>` edge to a service/no-reply sender,
    // or with an empty/uninformative value, is unreviewable junk — keep the row
    // server-side (intact + queryable) but never sync it to the /memory review
    // queue. Confirmed facts and all non-relationship facts are unaffected.
    return rows.filter(
      (f: UserFact) =>
        !(f.status === "proposed" && isUninformativeRelationshipFact(f.key, f.value)),
    );
  },
  map: (f: UserFact) => {
    if (f.status !== "proposed" && f.status !== "confirmed") {
      throw new SerializationError(`cannot sync fact with status '${f.status}'`);
    }
    // DB stores status as plain text; wire is narrowed to "proposed" | "confirmed".
    // Explicit narrow is the real work the old serializer did — without it a
    // renamed column would compile but silently skip every row.
    return {
      id: f.id,
      userId: f.userId,
      key: f.key,
      value: factValueSchema.parse(f.value),
      confidence: f.confidence,
      status: syncedFactSchema.shape.status.parse(f.status),
      source: f.source,
      validFrom: f.validFrom,
      validUntil: f.validUntil,
      supersedesId: f.supersedesId,
      rowVersion: f.rowVersion,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
    };
  },
});
