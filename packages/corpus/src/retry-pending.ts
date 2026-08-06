import { type Document } from "@alfred/db/schemas";
import { findUnembeddedDocumentIds, indexDocument } from "./embed-document";

/**
 * Sweep documents whose embed step never completed and (re-)index them.
 *
 * This folds the loop the ingestion worker used to assemble by hand
 * (`findUnembeddedDocumentIds` + per-id `indexDocument` in a try/catch) so
 * the corpus package owns the sweep, not its callers. The BullMQ schedule
 * that fires it stays in the api integrations queue — only the loop body
 * moved here.
 *
 * Counting rules are preserved exactly: a document counts as `succeeded`
 * only when `indexDocument` wrote (or would have written) chunks — an empty
 * / dead-lettered doc does not; a throw counts as `failed`. The durable
 * poison-pill record is written inside `indexDocument` before it rethrows,
 * so the failing document drops out of the candidate set on the next sweep
 * without any bookkeeping here.
 */
export interface RetryPendingArgs {
  source?: Document["source"];
  limit?: number;
}

export interface RetryPendingResult {
  candidates: number;
  succeeded: number;
  failed: number;
}

export async function retryPending(args: RetryPendingArgs = {}): Promise<RetryPendingResult> {
  const ids = await findUnembeddedDocumentIds({
    ...(args.source ? { source: args.source } : {}),
    limit: args.limit ?? 50,
  });
  let succeeded = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      const r = await indexDocument({ documentId: id });
      if (!r.empty) succeeded++;
    } catch {
      // Failure is durably recorded inside indexDocument (poison-pill guard)
      // before it rethrows; the summary count is all the sweep owner needs.
      failed++;
    }
  }
  return { candidates: ids.length, succeeded, failed };
}
