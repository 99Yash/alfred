import { db } from "@alfred/db";
import { notes, replicacheClient, replicacheClientGroup } from "@alfred/db/schemas";
import { asc, eq, sql } from "drizzle-orm";
import { getCVRStore, type CVRRow, type CVRSnapshot } from "./cvr";
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
    // different client group) is treated as cold sync.
    const cookieMatchesGroup = cookie != null && cookie.clientGroupID === clientGroupID;
    const prev: CVRSnapshot | null = cookieMatchesGroup
      ? await cvrStore.get(clientGroupID, cookie.order)
      : null;
    const isColdSync = prev == null;
    const prevSnapshot: CVRSnapshot = prev ?? { notes: {} };

    // Query all notes visible to this user, ordered by id for determinism.
    const currentNotes = await tx
      .select()
      .from(notes)
      .where(eq(notes.userId, userId))
      .orderBy(asc(notes.id));

    // Build next CVR and diff patch.
    const nextNotes: Record<string, CVRRow> = {};
    const patch: PatchOp[] = [];
    if (isColdSync) patch.push({ op: "clear" });

    for (const n of currentNotes) {
      nextNotes[n.id] = { v: n.rowVersion };
      const prevRow = prevSnapshot.notes[n.id];
      if (!prevRow || prevRow.v !== n.rowVersion) {
        patch.push({ op: "put", key: `note/${n.id}`, value: serializeNote(n) });
      }
    }

    // Emit del for rows present in prev snapshot but absent now (deletions).
    if (!isColdSync) {
      for (const id of Object.keys(prevSnapshot.notes)) {
        if (!nextNotes[id]) {
          patch.push({ op: "del", key: `note/${id}` });
        }
      }
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

    const nextSnapshot: CVRSnapshot = { notes: nextNotes, clients: currentLmids };

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
