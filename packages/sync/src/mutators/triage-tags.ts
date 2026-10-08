import { triageCategorySchema } from "@alfred/contracts";
import type { WriteTransaction } from "replicache";
import { z } from "zod";
import { SYNC_MODEL } from "../sync-model";
import type { SyncedTriageTag } from "../schemas";

export const triageTagOverrideArgsSchema = z.object({
  /** Gmail `source_thread_id`. */
  threadId: z.string().min(1).max(200),
  category: triageCategorySchema,
});

export type TriageTagOverrideArgs = z.infer<typeof triageTagOverrideArgsSchema>;

async function readTag(tx: WriteTransaction, threadId: string): Promise<SyncedTriageTag | null> {
  return SYNC_MODEL.triagetag.get(tx, { threadId });
}

async function writeTag(tx: WriteTransaction, tag: SyncedTriageTag): Promise<void> {
  await SYNC_MODEL.triagetag.put(tx, tag);
}

/** Turn the tag into a `user` tag. No-op before the first classify. */
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
    // Significance belongs to the sender, not the category, so keep it.
    senderSignificanceBand: tag.senderSignificanceBand,
    rowVersion: tag.rowVersion + 1,
    updatedAt: now,
    overriddenAt: now,
  });
}
