import { db } from "@alfred/db";
import {
  notes,
  replicacheClient,
  replicacheClientGroup,
  userFacts,
} from "@alfred/db/schemas";
import { IDB_KEY, IDB_KEY_NAMES, type IDBKeys } from "@alfred/sync";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getCVRStore, type ClientViewMap, type CVRRow, type CVRSnapshot } from "./cvr";
import type { ReplicacheModel } from "./model";

export type PatchOp =
  | { op: "put"; key: string; value: Record<string, unknown> }
  | { op: "del"; key: string }
  | { op: "clear" };

export type PullRequestBody = ReplicacheModel.Pull;

export interface PullResponse {
  cookie: ReplicacheModel.PullCookie;
  lastMutationIDChanges: Record<string, number>;
  patch: PatchOp[];
}

/**
 * One row's contribution to the patch: its row_version (drives CVR diff)
 * and its serialized form (the value Replicache writes to the client store).
 */
interface EntityRow {
  id: string;
  rowVersion: number;
  serialized: Record<string, unknown>;
}

/**
 * Per-entity fetcher. Each entry maps an `IDBKeys` slug to:
 *  - the SQL query that returns the user's currently-synced rows for that entity
 *  - the row → `EntityRow` projection
 *
 * The pull dispatcher iterates this table to produce patches generically;
 * adding a new entity is one entry here + one entry in `IDB_KEY`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbTx = any;

const ENTITY_FETCHERS: Record<IDBKeys, (tx: DbTx, userId: string) => Promise<EntityRow[]>> = {
  NOTE: async (tx, userId) => {
    const rows = await tx
      .select()
      .from(notes)
      .where(eq(notes.userId, userId))
      .orderBy(asc(notes.id));
    return rows.map((n: typeof notes.$inferSelect) => ({
      id: n.id,
      rowVersion: n.rowVersion,
      serialized: serializeNote(n),
    }));
  },

  // Only `proposed` + `confirmed` reach the client — rejected / edited /
  // superseded rows stay server-side as audit history. A status transition
  // out of this window naturally looks like a delete to the client (the
  // card disappears), which matches the correction-loop UX.
  FACT: async (tx, userId) => {
    const rows = await tx
      .select()
      .from(userFacts)
      .where(
        and(
          eq(userFacts.userId, userId),
          inArray(userFacts.status, ["proposed", "confirmed"]),
        ),
      )
      .orderBy(asc(userFacts.id));
    return rows.map((f: typeof userFacts.$inferSelect) => ({
      id: f.id,
      rowVersion: f.rowVersion,
      serialized: serializeFact(f),
    }));
  },
};

function serializeNote(n: {
  id: string;
  userId: string;
  text: string;
  rowVersion: number;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    id: n.id,
    userId: n.userId,
    text: n.text,
    createdAt: n.createdAt instanceof Date ? n.createdAt.toISOString() : n.createdAt,
    rowVersion: n.rowVersion,
  };
}

function serializeFact(f: typeof userFacts.$inferSelect): Record<string, unknown> {
  const toIso = (d: Date | null | undefined) =>
    d instanceof Date ? d.toISOString() : d ?? null;
  return {
    id: f.id,
    userId: f.userId,
    key: f.key,
    value: f.value,
    confidence: f.confidence,
    status: f.status,
    source: f.source,
    validFrom: toIso(f.validFrom),
    validUntil: toIso(f.validUntil),
    supersedesId: f.supersedesId,
    rowVersion: f.rowVersion,
    createdAt: toIso(f.createdAt),
    updatedAt: toIso(f.updatedAt),
  };
}

export async function handlePull(
  userId: string,
  body: PullRequestBody,
): Promise<PullResponse | { forbidden: true }> {
  const { clientGroupID, cookie } = body;
  const cvrStore = getCVRStore();

  return await db().transaction(async (tx) => {
    // Serialize concurrent pulls for the same client group via advisory lock.
    // Without this, two pulls can compute the same next cvr_version and both
    // return the same cookie — which Replicache rejects.
    const lockKey = clientGroupID;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);

    // Bind clientGroupID → userId on first pull; later pulls must match.
    const [existingGroup] = await tx
      .select()
      .from(replicacheClientGroup)
      .where(eq(replicacheClientGroup.id, clientGroupID));

    if (existingGroup) {
      if (existingGroup.userId !== userId) return { forbidden: true };
    } else {
      await tx
        .insert(replicacheClientGroup)
        .values({ id: clientGroupID, userId, cvrVersion: 0 })
        .onConflictDoNothing();
    }

    // Load previous CVR snapshot. A mismatch (e.g. stale cookie from a
    // different client group, or a pre-refactor snapshot shape) is treated
    // as cold sync.
    const cookieMatchesGroup = cookie != null && cookie.clientGroupID === clientGroupID;
    const prev: CVRSnapshot | null = cookieMatchesGroup
      ? await cvrStore.get(clientGroupID, cookie.order)
      : null;
    const isColdSync = prev == null || !prev.entities;
    const prevSnapshot: CVRSnapshot = prev ?? { entities: {} };

    const patch: PatchOp[] = [];
    if (isColdSync) patch.push({ op: "clear" });

    // Generic per-entity diff loop — driven entirely by IDB_KEY_NAMES so a
    // new entity adds one line to the registry + one fetcher above.
    const nextEntities: Partial<Record<IDBKeys, ClientViewMap>> = {};
    for (const slug of IDB_KEY_NAMES) {
      const rows = await ENTITY_FETCHERS[slug](tx, userId);
      const nextMap: ClientViewMap = {};
      const prevMap = prevSnapshot.entities?.[slug] ?? {};

      for (const r of rows) {
        nextMap[r.id] = { v: r.rowVersion };
        const prevRow: CVRRow | undefined = prevMap[r.id];
        if (!prevRow || prevRow.v !== r.rowVersion) {
          patch.push({ op: "put", key: IDB_KEY[slug]({ id: r.id }), value: r.serialized });
        }
      }

      if (!isColdSync) {
        for (const id of Object.keys(prevMap)) {
          if (!nextMap[id]) {
            patch.push({ op: "del", key: IDB_KEY[slug]({ id }) });
          }
        }
      }

      nextEntities[slug] = nextMap;
    }

    // Per-client LMID deltas — only emit clients whose LMID changed.
    const clients = await tx
      .select({ id: replicacheClient.id, lastMutationId: replicacheClient.lastMutationId })
      .from(replicacheClient)
      .where(eq(replicacheClient.clientGroupId, clientGroupID))
      .orderBy(asc(replicacheClient.id));

    const currentLmids: Record<string, number> = {};
    for (const c of clients) currentLmids[c.id] = c.lastMutationId;
    const prevLmids = prevSnapshot.clients ?? {};
    const lastMutationIDChanges: Record<string, number> = {};
    for (const [cid, lmid] of Object.entries(currentLmids)) {
      if (prevLmids[cid] !== lmid) lastMutationIDChanges[cid] = lmid;
    }

    const nextSnapshot: CVRSnapshot = {
      entities: nextEntities,
      clients: currentLmids,
    };

    // Bump cvr_version only when something changed.
    const prevVersion = existingGroup?.cvrVersion ?? 0;
    const hasChanges = patch.length > 0 || Object.keys(lastMutationIDChanges).length > 0;
    const nextVersion = hasChanges ? prevVersion + 1 : prevVersion;

    if (nextVersion !== prevVersion) {
      await cvrStore.put(clientGroupID, nextVersion, nextSnapshot);
      await tx
        .update(replicacheClientGroup)
        .set({ cvrVersion: nextVersion })
        .where(eq(replicacheClientGroup.id, clientGroupID));
    }

    return {
      cookie: { order: nextVersion, clientGroupID },
      lastMutationIDChanges,
      patch,
    };
  });
}
