import { mapConcurrent, withDefaults } from "@alfred/contracts";
import {
  registerGmailTriageHandler,
  type GmailTriageHandler,
  type GmailTriageRelabelResult,
  enqueueTriageRelabel,
} from "@alfred/assistant/connections/ingestion";
import {
  findNewestLiveInboundGmailDocuments,
  reconcileGmailThreads,
  reconcileThreadLabel,
  type ReconcileResult,
} from "@alfred/assistant/triage";
import { logger } from "@alfred/logging";

const RELABEL_ENQUEUE_CONCURRENCY = 10;

let unregisterGmailTriageHandler: (() => void) | undefined;

interface GmailTriageAdapterDeps {
  reconcileThreads: typeof reconcileGmailThreads;
  enqueueRelabel: typeof enqueueTriageRelabel;
  findNewestLiveInbound: typeof findNewestLiveInboundGmailDocuments;
  reconcileLabel: typeof reconcileThreadLabel;
}

const DEFAULT_DEPS: GmailTriageAdapterDeps = {
  reconcileThreads: reconcileGmailThreads,
  enqueueRelabel: enqueueTriageRelabel,
  findNewestLiveInbound: findNewestLiveInboundGmailDocuments,
  reconcileLabel: reconcileThreadLabel,
};

function connectionRelabelResult(result: ReconcileResult): GmailTriageRelabelResult {
  return result.applied
    ? { applied: true, appliedLabelId: result.appliedLabelId }
    : { applied: false, reason: result.reason };
}

/** Build the triage adapter. Overrides are an internal seam for adapter tests. */
export function createGmailTriageHandler(
  overrides: Partial<GmailTriageAdapterDeps> = {},
): GmailTriageHandler {
  const deps = withDefaults(DEFAULT_DEPS, overrides);

  return {
    async postInsert(request) {
      try {
        const result = await deps.reconcileThreads({
          credentialId: request.credentialId,
          userId: request.userId,
          threadIds: request.reconcileThreadIds,
          protectedDocumentIds: request.protectedDocumentIds,
        });

        if (result.docsDeleted > 0 || result.triageRepointed > 0) {
          logger.info(
            `[ingestion:worker] gmail.reconcile credential=${request.credentialId} ` +
              `threadsChecked=${result.threadsChecked} reconciled=${result.threadsReconciled} ` +
              `docsDeleted=${result.docsDeleted} triageRepointed=${result.triageRepointed}`,
          );
        }

        await mapConcurrent(
          result.repointedThreadIds,
          RELABEL_ENQUEUE_CONCURRENCY,
          async (threadId) => {
            try {
              await deps.enqueueRelabel(request.userId, threadId);
            } catch (err) {
              logger.warn(
                { err },
                `[ingestion:worker] reconcile relabel enqueue failed thread=${threadId}`,
              );
            }
          },
        );
      } catch (err) {
        logger.warn(
          { err },
          `[ingestion:worker] reconcileThreads failed credential=${request.credentialId}`,
        );
      }

      let replyReevalTargets: Array<{ threadId: string; documentId: string }> = [];

      try {
        replyReevalTargets = (
          await deps.findNewestLiveInbound({
            credentialId: request.credentialId,
            userId: request.userId,
            threadIds: request.replyReevalThreadIds,
          })
        ).map(({ threadId, documentId }) => ({ threadId, documentId }));
      } catch (err) {
        logger.warn(
          { err },
          `[ingestion:worker] live inbound resolve failed credential=${request.credentialId}`,
        );
      }

      return { replyReevalTargets };
    },
    async relabel(request) {
      return connectionRelabelResult(await deps.reconcileLabel(request));
    },
  };
}

/** Connect Gmail ingestion to triage without making integrations import triage. */
export function registerGmailTriage(): void {
  if (unregisterGmailTriageHandler) return;
  unregisterGmailTriageHandler = registerGmailTriageHandler(createGmailTriageHandler());
}

export function unregisterGmailTriage(): void {
  unregisterGmailTriageHandler?.();
  unregisterGmailTriageHandler = undefined;
}
