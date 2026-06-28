import { applyTriageLabel, findThreadSiblingsWithAlfredLabels } from "@alfred/integrations/google";
import { isHttpError } from "@alfred/contracts";
import type { TriageCategory } from "@alfred/contracts";
import { findNewestLiveInboundGmailDocuments } from "./gmail-reconcile";
import {
  getTriage,
  loadTriageContext,
  setAppliedLabelId,
  setTriageReconciledTarget,
  withTriageThreadLock,
  type TriageDocumentContext,
} from "./store";

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
  | {
      applied: false;
      reason: "tag-not-found" | "document-not-found" | "target-unresolvable";
      category?: TriageCategory;
    };

export interface ReconcileThreadLabelArgs {
  userId: string;
  sourceThreadId: string;
  /** Workflow-only fallback for legacy rows with no canonical document pointer. */
  fallbackDocumentId?: string;
}

/**
 * The collaborators {@link reconcileThreadLabel} reaches for. Defaulted to the
 * real store/integration functions; the relabel test overrides them to drive
 * the stale-message-id (404) path without a live Gmail account or DB.
 */
export interface ReconcileThreadLabelDeps {
  getTriage: typeof getTriage;
  loadTriageContext: typeof loadTriageContext;
  findThreadSiblings: typeof findThreadSiblingsWithAlfredLabels;
  applyTriageLabel: typeof applyTriageLabel;
  findNewestLiveInbound: typeof findNewestLiveInboundGmailDocuments;
  setAppliedLabelId: typeof setAppliedLabelId;
  setReconciledTarget: typeof setTriageReconciledTarget;
  withThreadLock: typeof withTriageThreadLock;
}

const DEFAULT_DEPS: ReconcileThreadLabelDeps = {
  getTriage,
  loadTriageContext,
  findThreadSiblings: findThreadSiblingsWithAlfredLabels,
  applyTriageLabel,
  findNewestLiveInbound: findNewestLiveInboundGmailDocuments,
  setAppliedLabelId,
  setReconciledTarget: setTriageReconciledTarget,
  withThreadLock: withTriageThreadLock,
};

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
  deps: Partial<ReconcileThreadLabelDeps> = {},
): Promise<ReconcileResult> {
  const d: ReconcileThreadLabelDeps = { ...DEFAULT_DEPS, ...deps };
  return d.withThreadLock(args.userId, args.sourceThreadId, async () => {
    const row = await d.getTriage(args.userId, args.sourceThreadId);
    if (!row) return { applied: false, reason: "tag-not-found" };
    const targetDocId = row.documentId ?? args.fallbackDocumentId;
    if (!targetDocId) {
      return { applied: false, reason: "document-not-found", category: row.category };
    }

    let target = await d.loadTriageContext(targetDocId, args.userId);
    if (!target && args.fallbackDocumentId && targetDocId !== args.fallbackDocumentId) {
      target = await d.loadTriageContext(args.fallbackDocumentId, args.userId);
    }
    if (!target) {
      return { applied: false, reason: "document-not-found", category: row.category };
    }

    // Apply the row's category to one Gmail message and collapse the thread to a
    // single tag (strip alfred labels off every sibling). Returns the applied
    // label + the sibling count for the result.
    const labelTarget = async (ctx: TriageDocumentContext) => {
      const siblings = await d.findThreadSiblings({
        credentialId: ctx.credentialId,
        threadId: args.sourceThreadId,
        excludeMessageId: ctx.document.sourceId,
      });
      const result = await d.applyTriageLabel({
        credentialId: ctx.credentialId,
        messageId: ctx.document.sourceId,
        category: row.category,
        stripAllAlfredLabels: true,
        threadSiblings: siblings,
      });
      return { result, siblingCount: siblings.length };
    };

    let outcome: Awaited<ReturnType<typeof labelTarget>>;
    let repointed = false;
    try {
      outcome = await labelTarget(target);
    } catch (err) {
      // Gmail reassigns/collapses message ids when a sent copy merges into a
      // thread, so the stored `documents.source_id` can be dead — the modify
      // 404s and (pre-#277) the triage label silently never landed. Re-resolve
      // to the newest live inbound message in the thread and retry once.
      // (Sibling 404s are already swallowed inside applyTriageLabel, so a 404
      // surfacing here is the *target* message.)
      if (!isHttpError(err) || err.status !== 404) throw err;
      const [live] = await d.findNewestLiveInbound({
        credentialId: target.credentialId,
        userId: args.userId,
        threadIds: [args.sourceThreadId],
      });
      const liveTarget =
        live && live.documentId !== target.document.id
          ? await d.loadTriageContext(live.documentId, args.userId)
          : null;
      if (!liveTarget) {
        // Nothing live to fall back to — surface a durable signal (the worker
        // logs this at error level) rather than leaving applied_label_id
        // silently NULL and the thread looking untagged (#277).
        console.error(
          `[triage.relabel] thread=${args.sourceThreadId} target message ` +
            `${target.document.sourceId} is gone (Gmail 404) and no live inbound ` +
            `message to relabel — applied_label_id left unset`,
        );
        return { applied: false, reason: "target-unresolvable", category: row.category };
      }
      target = liveTarget;
      repointed = true;
      // A second 404 here (e.g. the live message died in a race) bubbles to the
      // job for a normal BullMQ retry rather than being swallowed.
      outcome = await labelTarget(liveTarget);
    }

    const appliedDocId = target.document.id;
    if (repointed) {
      // Persist BOTH the re-resolved document pointer and the applied label so
      // the row reflects the message that was actually labeled (#277).
      await d.setReconciledTarget(
        args.userId,
        args.sourceThreadId,
        appliedDocId,
        outcome.result.appliedLabelId,
      );
    } else {
      await d.setAppliedLabelId(args.userId, args.sourceThreadId, outcome.result.appliedLabelId);
    }
    return {
      applied: true,
      category: row.category,
      appliedLabelId: outcome.result.appliedLabelId,
      removedLabelIds: outcome.result.removedLabelIds,
      strippedSiblings: outcome.result.strippedSiblings,
      siblingCount: outcome.siblingCount,
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
