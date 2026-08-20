import { createMediaExtractor } from "@alfred/extraction";
import type { GmailMessage } from "@alfred/integrations/google";
import {
  ingestGmailMediaAttachments,
  type GmailMediaIngestDeps,
  type GmailMediaIngestResult,
} from "./gmail-media";

export type GmailAttachmentIngestResult = GmailMediaIngestResult;

/**
 * Deps for the legacy PDF-only door. This is intentionally the same shape
 * as `GmailMediaIngestDeps` — one interface, one seam. The PDF wrapper
 * only adds a `family === "pdf"` filter; it does not add a second
 * extraction hook.
 */
export type GmailAttachmentIngestDeps = GmailMediaIngestDeps;

export interface GmailAttachmentIngestArgs {
  userId: string;
  accountId: string;
  message: GmailMessage;
  accessToken: string;
  deps?: GmailAttachmentIngestDeps | undefined;
}

/**
 * @deprecated Use `ingestGmailMediaAttachments` from `./gmail-media`.
 * This PDF-only wrapper remains for DB-backed tests that assert
 * `gmail_attachment` rows with page offsets. It filters to `family === "pdf"`
 * and delegates to the generic loop so that `fetch → limit → extract →
 * persist → embed` has one owner (tier 3). New callers must not add
 * PDF-specific hooks here — add a family in `@alfred/contracts` and a
 * factory in `@alfred/extraction` instead.
 */
export async function ingestGmailPdfAttachments(
  args: GmailAttachmentIngestArgs,
): Promise<GmailAttachmentIngestResult> {
  const baseCreateExtractor = args.deps?.createExtractor;
  const pdfOnlyCreateExtractor: GmailMediaIngestDeps["createExtractor"] = (opts) => {
    if (opts.family !== "pdf") return null;
    if (baseCreateExtractor) return baseCreateExtractor(opts);
    return createMediaExtractor("gmailAttachment", "pdf");
  };

  return ingestGmailMediaAttachments({
    userId: args.userId,
    accountId: args.accountId,
    message: args.message,
    accessToken: args.accessToken,
    deps: {
      getAttachment: args.deps?.getAttachment,
      createExtractor: pdfOnlyCreateExtractor,
      indexDocument: args.deps?.indexDocument,
    },
  });
}
