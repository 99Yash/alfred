import { applyTriageLabel, findThreadSiblingsWithAlfredLabels } from "@alfred/integrations/google";
import type { TriageCategory } from "@alfred/contracts";
import { getTriage, loadTriageContext, setAppliedLabelId, withTriageThreadLock } from "./store";

/**
 * Triage-tag write surface (rfc-triage-tags.md).
 *
 * The user-override write itself is a Replicache server mutator (see
 * `serverMutators.triageTagOverride`) — it commits inside the push
 * transaction. This module owns the two pieces that must NOT live in that
 * transaction:
 *
 *  - {@link reconcileThreadLabel} — the ONE Gmail label-writer (Invariant 6).
 *    It is the extracted body of the `email-triage` workflow's `apply-label`
 *    step: hold the per-thread advisory lock, read the now-canonical
 *    `email_triage` row, apply its category to the thread's canonical message,
 *    strip every sibling's alfred label, persist `applied_label_id`. Both the
 *    classifier workflow and the override relabel job call this, so the two
 *    writers can never drift.
 *  - {@link enqueueTriageRelabel} — fire-and-forget enqueue of the relabel job,
 *    called AFTER the push transaction commits (mirrors `POLICY_BUST_MUTATORS`).
 */

/** Outcome of a single thread relabel — the closed result the job logs. */
export type ReconcileResult =
  | {
      applied: true;
      category: TriageCategory;
      appliedLabelId: string;
      removedLabelIds: string[];
      strippedSiblings: Array<{ messageId: string; labelId: string }>;
      siblingCount: number;
      targetDocId: string;
    }
  | { applied: false; reason: "tag-not-found" | "document-not-found"; category?: TriageCategory };

export interface ReconcileThreadLabelArgs {
  userId: string;
  sourceThreadId: string;
  /** Workflow-only fallback for legacy rows with no canonical document pointer. */
  fallbackDocumentId?: string;
}

/**
 * Converge the thread's Gmail label to its current `email_triage.category`,
 * under the per-thread advisory lock. Idempotent: re-reads the row and
 * reproduces the same single tag regardless of caller ordering.
 *
 * Shared by the workflow's `apply-label` step and the async relabel job so
 * classifier tags and user overrides cannot drift.
 */
export async function reconcileThreadLabel(
  args: ReconcileThreadLabelArgs,
): Promise<ReconcileResult> {
  return withTriageThreadLock(args.userId, args.sourceThreadId, async () => {
    const row = await getTriage(args.userId, args.sourceThreadId);
    if (!row) return { applied: false, reason: "tag-not-found" };
    const targetDocId = row.documentId ?? args.fallbackDocumentId;
    if (!targetDocId) {
      return { applied: false, reason: "document-not-found", category: row.category };
    }

    let target = await loadTriageContext(targetDocId, args.userId);
    if (!target && args.fallbackDocumentId && targetDocId !== args.fallbackDocumentId) {
      target = await loadTriageContext(args.fallbackDocumentId, args.userId);
    }
    if (!target) {
      return { applied: false, reason: "document-not-found", category: row.category };
    }
    const appliedDocId = target.document.id;

    const siblings = await findThreadSiblingsWithAlfredLabels({
      credentialId: target.credentialId,
      threadId: args.sourceThreadId,
      excludeMessageId: target.document.sourceId,
    });

    const result = await applyTriageLabel({
      credentialId: target.credentialId,
      messageId: target.document.sourceId,
      category: row.category,
      stripAllAlfredLabels: true,
      threadSiblings: siblings,
    });

    await setAppliedLabelId(args.userId, args.sourceThreadId, result.appliedLabelId);
    return {
      applied: true,
      category: row.category,
      appliedLabelId: result.appliedLabelId,
      removedLabelIds: result.removedLabelIds,
      strippedSiblings: result.strippedSiblings,
      siblingCount: siblings.length,
      targetDocId: appliedDocId,
    };
  });
}

/**
 * Enqueue a `triage.relabel` job for one thread. Called from the Replicache
 * push handler after commit when a `triageTagOverride` mutation applied.
 * Best-effort — a failed enqueue logs and is retried by the next override.
 */
export async function enqueueTriageRelabel(userId: string, sourceThreadId: string): Promise<void> {
  const { getIngestionQueue } = await import("../integrations/queue");
  const queue = getIngestionQueue();
  await queue.add(
    "triage.relabel",
    { kind: "triage.relabel", userId, sourceThreadId },
    {
      deduplication: {
        id: `triage.relabel.${userId}.${sourceThreadId}`,
        keepLastIfActive: true,
      },
    },
  );
}
