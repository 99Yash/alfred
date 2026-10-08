import { applyTriageLabel, findThreadSiblingsWithAlfredLabels } from "@alfred/integrations/google";
import { isHttpError, withDefaults } from "@alfred/contracts";
import type { TriageCategory } from "@alfred/contracts";
import { gmailMailboxWritesEnabled } from "@alfred/env/server";
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
 * The Gmail side of triage tags (`docs/rfc-triage-tags.md`). The user override is
 * a Replicache mutator; Gmail writes cannot run inside its push transaction, so
 * {@link reconcileThreadLabel} is the one Gmail label writer (Invariant 6).
 */

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
      reason: "tag-not-found" | "document-not-found" | "target-unresolvable" | "writes-disabled";
      category?: TriageCategory | undefined;
    };

export interface ReconcileThreadLabelArgs {
  userId: string;
  sourceThreadId: string;
  /** Workflow only: for legacy rows with no document pointer. */
  fallbackDocumentId?: string;
}

/** Tests override these to drive the 404 path without Gmail or a DB. */
export interface ReconcileThreadLabelDeps {
  getTriage: typeof getTriage;
  loadTriageContext: typeof loadTriageContext;
  findThreadSiblings: typeof findThreadSiblingsWithAlfredLabels;
  applyTriageLabel: typeof applyTriageLabel;
  findNewestLiveInbound: typeof findNewestLiveInboundGmailDocuments;
  setAppliedLabelId: typeof setAppliedLabelId;
  setReconciledTarget: typeof setTriageReconciledTarget;
  withThreadLock: typeof withTriageThreadLock;
  mailboxWritesEnabled: typeof gmailMailboxWritesEnabled;
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
  mailboxWritesEnabled: gmailMailboxWritesEnabled,
};

/**
 * Converge the thread's Gmail label to the row's category, under the thread lock.
 * Idempotent. Used by both the classify workflow and the override relabel job.
 */
export async function reconcileThreadLabel(
  args: ReconcileThreadLabelArgs,
  deps: Partial<ReconcileThreadLabelDeps> = {},
): Promise<ReconcileResult> {
  const d = withDefaults(DEFAULT_DEPS, deps);

  // Dev and prod share one Gmail account, so non-prod must not write labels (#278).
  if (!d.mailboxWritesEnabled()) {
    const row = await d.getTriage(args.userId, args.sourceThreadId);

    return { applied: false, reason: "writes-disabled", category: row?.category };
  }

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

    // Label one message and strip alfred labels from its siblings.
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
      // A sent copy merging into the thread can kill the stored message id (#277).
      // Retry once on the newest live inbound. Sibling 404s never reach here.
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
        // Log loudly rather than leave the thread silently untagged (#277).
        console.error(
          `[triage.relabel] thread=${args.sourceThreadId} target message ` +
            `${target.document.sourceId} is gone (Gmail 404) and no live inbound ` +
            `message to relabel — applied_label_id left unset`,
        );

        return { applied: false, reason: "target-unresolvable", category: row.category };
      }

      target = liveTarget;
      repointed = true;
      // A second 404 goes to the job for a normal BullMQ retry.
      outcome = await labelTarget(liveTarget);
    }

    const appliedDocId = target.document.id;

    if (repointed) {
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
