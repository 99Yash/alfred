import { isUninformativeRelationshipFact } from "@alfred/assistant/knowledge";
import { userFacts, type UserFact } from "@alfred/db/schemas";
import { SYNC_MODEL } from "@alfred/sync";
import { and, asc, eq, inArray } from "drizzle-orm";
import { SerializationError } from "./entity-row";
import { syncEntity } from "./sync-entity";

const syncsToClient = (userId: string) =>
  and(eq(userFacts.userId, userId), inArray(userFacts.status, ["proposed", "confirmed"]));

// Hide proposed relationship facts nobody can review (no-reply senders, empty values).
// Both stages run it, in case the value changes during the pull.
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
