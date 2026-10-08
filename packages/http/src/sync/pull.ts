import { db } from "@alfred/db";
import { replicacheClient, replicacheClientGroup } from "@alfred/db/schemas";
import { SYNC_MODEL, type IDBKeys, type SyncedEntity } from "@alfred/sync";
import { asc, eq, sql } from "drizzle-orm";
import { getCVRStore, type ClientViewMap, type CVRRow, type CVRSnapshot } from "./cvr";
import { SYNC_ENTITIES } from "./read";
import { ReplicacheModel } from "./model";

type PatchOp =
  | { op: "put"; key: string; value: SyncedEntity }
  | { op: "del"; key: string }
  | { op: "clear" };

export type PullRequestBody = ReplicacheModel.Pull;

export interface PullResponse {
  cookie: ReplicacheModel.PullCookie;
  lastMutationIDChanges: Record<string, number>;
  patch: PatchOp[];
}

/**
 * Any bad cookie shape is `null`, a cold sync. `order` is capped below the Postgres
 * integer max, because pull adds 1 before it stores the cookie.
 */
function narrowPullCookie(raw: unknown): ReplicacheModel.PullCookie | null {
  const parsed = ReplicacheModel.pullCookieSchema.safeParse(raw);

  return parsed.success ? parsed.data : null;
}

export async function handlePull(
  userId: string,
  body: PullRequestBody,
): Promise<PullResponse | { forbidden: true }> {
  const cookie = narrowPullCookie(body.cookie);
  const cvrStore = getCVRStore();

  return await db().transaction(async (tx) => {
    // Without the lock, two pulls can return the same cookie, which Replicache rejects.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${body.clientGroupID}))`);

    // Bind clientGroupID → userId on first pull; later pulls must match.
    const [existingGroup] = await tx
      .select()
      .from(replicacheClientGroup)
      .where(eq(replicacheClientGroup.id, body.clientGroupID));

    if (existingGroup) {
      if (existingGroup.userId !== userId) return { forbidden: true };
    } else {
      await tx
        .insert(replicacheClientGroup)
        .values({ id: body.clientGroupID, userId, cvrVersion: 0 })
        .onConflictDoNothing();
    }

    // A missing cookie, another client group, or an unreadable snapshot is a cold sync.
    const cookieMatchesGroup = cookie != null && cookie.clientGroupID === body.clientGroupID;

    const prev: CVRSnapshot | null = cookieMatchesGroup
      ? await cvrStore.get(body.clientGroupID, cookie.order)
      : null;

    const isColdSync = prev == null;
    const prevSnapshot: CVRSnapshot = prev ?? { entities: {} };

    const patch: PatchOp[] = [];

    if (isColdSync) patch.push({ op: "clear" });

    // `SYNC_ENTITIES` is tied to `SYNC_MODEL` at compile time, so no entity can skip pull.
    const nextEntities: Partial<Record<IDBKeys, ClientViewMap>> = {};

    for (const { slug, fetchRows } of SYNC_ENTITIES) {
      const prevMap = prevSnapshot.entities[slug] ?? {};
      const { unchanged, rows } = await fetchRows(tx, userId, prevMap);
      const nextMap: ClientViewMap = {};

      for (const version of unchanged) {
        nextMap[version.id] = { v: version.rowVersion };
      }

      for (const r of rows) {
        nextMap[r.id] = { v: r.rowVersion };
        const prevRow: CVRRow | undefined = prevMap[r.id];

        if (!prevRow || prevRow.v !== r.rowVersion) {
          patch.push({
            op: "put",
            key: r.storageKey,
            value: r.serialized,
          });
        }
      }

      if (!isColdSync) {
        for (const id of Object.keys(prevMap)) {
          if (!nextMap[id]) {
            patch.push({ op: "del", key: SYNC_MODEL[slug].storageKeyForCVRId(id) });
          }
        }
      }

      nextEntities[slug] = nextMap;
    }

    const clients = await tx
      .select({ id: replicacheClient.id, lastMutationId: replicacheClient.lastMutationId })
      .from(replicacheClient)
      .where(eq(replicacheClient.clientGroupId, body.clientGroupID))
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

    // The cookie order must never go back: Replicache then rejects the patch and re-pulls forever.
    // A forked client group starts at 0 but keeps the old cookie, so start from `cookie.order`,
    // even when the group does not match.
    const prevVersion = existingGroup?.cvrVersion ?? 0;
    const hasChanges = patch.length > 0 || Object.keys(lastMutationIDChanges).length > 0;
    const nextVersion = hasChanges ? Math.max(prevVersion, cookie?.order ?? 0) + 1 : prevVersion;

    if (nextVersion !== prevVersion) {
      await cvrStore.put(body.clientGroupID, nextVersion, nextSnapshot);
      await tx
        .update(replicacheClientGroup)
        .set({ cvrVersion: nextVersion })
        .where(eq(replicacheClientGroup.id, body.clientGroupID));
    }

    return {
      cookie: { order: nextVersion, clientGroupID: body.clientGroupID },
      lastMutationIDChanges,
      patch,
    };
  });
}
