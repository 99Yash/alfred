import { isUninformativeRelationshipFact } from "@alfred/assistant/knowledge";
import { userFacts, type UserFact } from "@alfred/db/schemas";
import { SYNC_MODEL } from "@alfred/sync";
import { and, asc, eq, inArray } from "drizzle-orm";
import { SerializationError } from "./entity-row";
import { syncEntity } from "./sync-entity";

// Only `proposed` + `confirmed` reach the client; rejected / edited /
// superseded rows stay server-side as audit history.
const syncsToClient = (userId: string) =>
  and(eq(userFacts.userId, userId), inArray(userFacts.status, ["proposed", "confirmed"]));

// #491: a proposed `relationship:<email>` edge to a service/no-reply sender,
// or with an empty/uninformative value, is unreviewable junk — keep the row
// server-side (intact + queryable) but never sync it to the /memory review
// queue. Confirmed facts and all non-relationship facts are unaffected.
//
// This takes only the three columns it reads, so the version query can carry it
// and the membership decision never needs the row's other columns. Both query
// stages run it: the version stage so an unreviewable row is never even counted
// as membership, the load stage as the guard that stays if a changed row's key or
// value flipped while the pull ran.
const isSyncedFact = (f: Pick<UserFact, "status" | "key" | "value">) =>
  !(f.status === "proposed" && isUninformativeRelationshipFact(f.key, f.value));

export const fetchFacts = syncEntity(SYNC_MODEL.fact, {
  versionQuery: async (tx, userId) => {
    const rows = await tx
      .select({
        id: userFacts.id,
        rowVersion: userFacts.rowVersion,
        status: userFacts.status,
        key: userFacts.key,
        value: userFacts.value,
      })
      .from(userFacts)
      .where(syncsToClient(userId))
      .orderBy(asc(userFacts.id));

    return rows.filter(isSyncedFact);
  },
  loadQuery: async (tx, userId, changed) => {
    const rows: UserFact[] = await tx
      .select()
      .from(userFacts)
      .where(
        and(
          syncsToClient(userId),
          inArray(
            userFacts.id,
            changed.map((v) => v.id),
          ),
        ),
      )
      .orderBy(asc(userFacts.id));

    return rows.filter(isSyncedFact);
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
