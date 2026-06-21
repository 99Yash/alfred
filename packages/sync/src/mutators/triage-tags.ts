import { triageCategorySchema } from "@alfred/contracts";
import type { WriteTransaction } from "replicache";
import { z } from "zod";
import { IDB_KEY, normalizeToReadonlyJSON } from "../keys";
import { syncedTriageTagSchema } from "../schemas";
import type { SyncedTriageTag } from "../types";
import { readSyncedValue } from "./read";

/**
 * Client-side triage-tag mutator (rfc-triage-tags.md). The user overrides a
 * thread's tag; the optimistic patch flips the local row to a `user` variant
 * (dropping classifier provenance so no confidence renders), and the server
 * mutator writes `email_triage` + enqueues the Gmail relabel after commit.
 *
 * Read-only by design otherwise: classifier-authored (`auto`) tags arrive via
 * pull, never a client mutator.
 */

export const triageTagOverrideArgsSchema = z.object({
  /** Gmail `source_thread_id` (the IDB key). */
  threadId: z.string().min(1).max(200),
  category: triageCategorySchema,
});
export type TriageTagOverrideArgs = z.infer<typeof triageTagOverrideArgsSchema>;

async function readTag(tx: WriteTransaction, threadId: string): Promise<SyncedTriageTag | null> {
  return readSyncedValue(tx, IDB_KEY.TRIAGE_TAG({ id: threadId }), syncedTriageTagSchema);
}

async function writeTag(tx: WriteTransaction, tag: SyncedTriageTag): Promise<void> {
  await tx.set(IDB_KEY.TRIAGE_TAG({ id: tag.threadId }), normalizeToReadonlyJSON(tag));
}

/**
 * Override a thread's tag: produce a `user` variant carrying `overriddenAt`
 * and no classifier fields. No-op if the thread has no tag yet (override
 * before first classify) — the eventual classify writes `auto` and the user
 * can override again.
 */
export async function triageTagOverrideClient(
  tx: WriteTransaction,
  args: TriageTagOverrideArgs,
): Promise<void> {
  const tag = await readTag(tx, args.threadId);
  if (!tag) return;
  const now = new Date().toISOString();
  await writeTag(tx, {
    source: "user",
    threadId: tag.threadId,
    userId: tag.userId,
    category: args.category,
    documentId: tag.documentId,
    appliedLabelId: null,
    // Sender significance is a property of the sender, not the classification —
    // a user pinning the category doesn't change who's asking, so carry it over.
    senderSignificanceBand: tag.senderSignificanceBand,
    rowVersion: tag.rowVersion + 1,
    updatedAt: now,
    overriddenAt: now,
  });
}
