import { isUninformativeRelationshipFact } from "@alfred/assistant/knowledge";
import { userFacts, type UserFact } from "@alfred/db/schemas";
import { SYNC_MODEL } from "@alfred/sync";
import { and, asc, eq, inArray } from "drizzle-orm";
import { SerializationError } from "./entity-row";
import { syncEntity } from "./sync-entity";

// Only `proposed` + `confirmed` reach the client; rejected / edited /
// superseded rows stay server-side as audit history.
export const fetchFacts = syncEntity(SYNC_MODEL.fact, {
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
    return {
      id: f.id,
      userId: f.userId,
      key: f.key,
      value: f.value,
      confidence: f.confidence,
      status: f.status,
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
