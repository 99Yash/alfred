import { type Document } from "@alfred/db/schemas";
import { findUnembeddedDocumentIds, indexDocument } from "./embed-document";

export interface RetryPendingArgs {
  /** Omit to sweep every user. `source` alone does not isolate rows: every source has live writers. */
  userId?: string;
  source?: Document["source"];
  limit?: number;
}

export interface RetryPendingResult {
  candidates: number;
  succeeded: number;
  failed: number;
}

/** Index documents whose embed never finished. An empty document does not count as `succeeded`. */
export async function retryPending(args: RetryPendingArgs = {}): Promise<RetryPendingResult> {
  const ids = await findUnembeddedDocumentIds({
    ...(args.userId ? { userId: args.userId } : {}),
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
      // indexDocument already recorded the failure.
      failed++;
    }
  }

  return { candidates: ids.length, succeeded, failed };
}
