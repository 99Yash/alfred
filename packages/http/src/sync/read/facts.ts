import { isUninformativeRelationshipFact } from "@alfred/assistant/knowledge";
import { userFacts, type UserFact } from "@alfred/db/schemas";
import { memorySourceSchema, syncedFactSchema, type SyncedFact } from "@alfred/sync";
import { and, asc, eq, inArray } from "drizzle-orm";
import { SerializationError, toEntityRow, type EntityFetcher } from "./entity-row";
import { toIso, toRequiredIso } from "./iso-date";

// Only `proposed` + `confirmed` reach the client; rejected / edited /
// superseded rows stay server-side as audit history.
export const fetchFacts: EntityFetcher = async (tx, userId) => {
  const rows = await tx
    .select()
    .from(userFacts)
    .where(and(eq(userFacts.userId, userId), inArray(userFacts.status, ["proposed", "confirmed"])))
    .orderBy(asc(userFacts.id));
  return rows.flatMap((f: UserFact) => {
    // #491: a proposed `relationship:<email>` edge to a service/no-reply sender,
    // or with an empty/uninformative value, is unreviewable junk — keep the row
    // server-side (intact + queryable) but never sync it to the /memory review
    // queue. Confirmed facts and all non-relationship facts are unaffected.
    if (f.status === "proposed" && isUninformativeRelationshipFact(f.key, f.value)) {
      return [];
    }
    return toEntityRow({
      slug: "FACT",
      id: f.id,
      rowVersion: f.rowVersion,
      serialize: () => serializeFact(f),
    });
  });
};

function serializeFact(f: UserFact): SyncedFact {
  if (f.status !== "proposed" && f.status !== "confirmed") {
    throw new SerializationError(`cannot sync fact with status '${f.status}'`);
  }
  return syncedFactSchema.parse({
    id: f.id,
    userId: f.userId,
    key: f.key,
    value: f.value,
    confidence: f.confidence,
    status: f.status,
    source: memorySourceSchema.parse(f.source),
    validFrom: toRequiredIso(f.validFrom, "userFacts.validFrom"),
    validUntil: toIso(f.validUntil),
    supersedesId: f.supersedesId,
    rowVersion: f.rowVersion,
    createdAt: toRequiredIso(f.createdAt, "userFacts.createdAt"),
    updatedAt: toIso(f.updatedAt),
  });
}
