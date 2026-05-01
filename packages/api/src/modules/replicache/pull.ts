import { db } from "@alfred/db";
import {
  notes,
  replicacheClient,
  replicacheClientGroup,
  userFacts,
} from "@alfred/db/schemas";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
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

    // Query the actionable user_facts (proposed + confirmed). The other
    // statuses stay server-side — they're audit history, not part of
    // the correction-loop UX surface.
    const currentFacts = await tx
      .select()
      .from(userFacts)
      .where(
        and(
          eq(userFacts.userId, userId),
          inArray(userFacts.status, ["proposed", "confirmed"]),
        ),
      )
      .orderBy(asc(userFacts.id));

    // Build next CVR and diff patch.
    const nextNotes: Record<string, CVRRow> = {};
    const nextFacts: Record<string, CVRRow> = {};
    const patch: PatchOp[] = [];
    if (isColdSync) patch.push({ op: "clear" });

    for (const n of currentNotes) {
      nextNotes[n.id] = { v: n.rowVersion };
      const prevRow = prevSnapshot.notes[n.id];
      if (!prevRow || prevRow.v !== n.rowVersion) {
        patch.push({ op: "put", key: `note/${n.id}`, value: serializeNote(n) });
      }
    }

    const prevFacts = prevSnapshot.facts ?? {};
    for (const f of currentFacts) {
      nextFacts[f.id] = { v: f.rowVersion };
      const prevRow = prevFacts[f.id];
      if (!prevRow || prevRow.v !== f.rowVersion) {
        patch.push({ op: "put", key: `fact/${f.id}`, value: serializeFact(f) });
      }
    }

    // Emit del for rows present in prev snapshot but absent now (deletions).
    // Includes both real deletes AND status transitions out of the
    // {proposed, confirmed} window — a fact moving to `rejected` looks
    // like a deletion to the client, which matches the UX (the card
    // disappears).
    if (!isColdSync) {
      for (const id of Object.keys(prevSnapshot.notes)) {
        if (!nextNotes[id]) {
          patch.push({ op: "del", key: `note/${id}` });
        }
      }
      for (const id of Object.keys(prevFacts)) {
        if (!nextFacts[id]) {
          patch.push({ op: "del", key: `fact/${id}` });
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

    const nextSnapshot: CVRSnapshot = {
      notes: nextNotes,
      facts: nextFacts,
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
