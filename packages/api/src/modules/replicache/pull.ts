import { db } from "@alfred/db";
import { replicacheClient, replicacheClientGroup } from "@alfred/db/schemas";
import { IDB_KEY, type IDBKeys } from "@alfred/sync";
import { asc, eq, sql } from "drizzle-orm";
import { getCVRStore, type ClientViewMap, type CVRRow, type CVRSnapshot } from "./cvr";
import { SYNC_ENTITIES } from "./entities";
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
 * Replicache sends `cookie: null` on first pull and a
 * `{ order, clientGroupID }` object thereafter. The route's TypeBox
 * schema types `cookie` as `unknown` (to avoid `t.Nullable`'s Union
 * desugaring); this helper does the runtime narrow, returning `null`
 * for any non-conforming shape — treated downstream as cold-sync,
 * matching the prior `t.Nullable` semantics.
 */
function narrowPullCookie(raw: unknown): ReplicacheModel.PullCookie | null {
  if (raw == null || typeof raw !== "object") return null;
  const obj = raw as { order?: unknown; clientGroupID?: unknown };
  if (typeof obj.order !== "number" || !Number.isInteger(obj.order) || obj.order < 0) {
    return null;
  }
  if (typeof obj.clientGroupID !== "string" || obj.clientGroupID.length === 0) {
    return null;
  }
  return { order: obj.order, clientGroupID: obj.clientGroupID };
}

export async function handlePull(
  userId: string,
  body: PullRequestBody,
): Promise<PullResponse | { forbidden: true }> {
  const { clientGroupID } = body;
  const cookie = narrowPullCookie(body.cookie);
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

    // Generic per-entity diff loop. `SYNC_ENTITIES` is compile-tied to
    // `IDB_KEY`, so a new client-visible entity cannot skip server pull.
    const nextEntities: Partial<Record<IDBKeys, ClientViewMap>> = {};
    for (const { slug, fetchRows } of SYNC_ENTITIES) {
      const rows = await fetchRows(tx, userId);
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
