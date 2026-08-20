import { isPdfContentType } from "@alfred/contracts";
import {
  createMediaExtractor,
  mediaResultFromExtractedPdf,
  type ExtractPdf,
  type MediaExtractor,
} from "@alfred/extraction";
import type { GmailMessage } from "@alfred/integrations/google";
import { ingestGmailMediaAttachments, type GmailMediaIngestResult } from "./gmail-media";

export type GmailAttachmentIngestResult = GmailMediaIngestResult;

export interface GmailAttachmentIngestDeps {
  getAttachment?:
    | ((args: {
        accessToken: string;
        messageId: string;
        attachmentId: string;
      }) => Promise<{ bytes: Uint8Array; size: number }>)
    | undefined;
  extractPdf?: ExtractPdf | undefined;
  indexDocument?: ((args: { documentId: string }) => Promise<unknown>) | undefined;
}

export interface GmailAttachmentIngestArgs {
  userId: string;
  accountId: string;
  message: GmailMessage;
  accessToken: string;
  deps?: GmailAttachmentIngestDeps | undefined;
}

/**
 * Backward-compatible PDF-only entry. Delegates to the generic media ingest
 * so the fetch/persist/embed loop stays in one place (tier 3). New callers
 * should use `ingestGmailMediaAttachments` which dispatches by
 * `contentFamily` via `@alfred/contracts` and `@alfred/extraction`.
 */
export async function ingestGmailPdfAttachments(
  args: GmailAttachmentIngestArgs,
): Promise<GmailAttachmentIngestResult> {
  // Bridge old `ExtractPdf` shape to `MediaExtractor` shape when tests
  // inject a stub. Production callers pass no extractor and get the
  // registry default.
  const pdfExtractorFactory =
    (extractor: ExtractPdf): MediaExtractor =>
    async (bytes) =>
      mediaResultFromExtractedPdf(await extractor(bytes));

  // Generic ingest handles all families; filter to PDF for this legacy door.
  // The filter lives here so the generic can stay family-agnostic.
  if (args.deps?.extractPdf) {
    const extractor = pdfExtractorFactory(args.deps.extractPdf);
    return ingestGmailMediaAttachments({
      userId: args.userId,
      accountId: args.accountId,
      message: args.message,
      accessToken: args.accessToken,
      deps: {
        getAttachment: args.deps.getAttachment,
        createExtractor: (opts) => {
          if (!isPdfContentType(opts.mimeType)) return null;
          return extractor;
        },
        indexDocument: args.deps.indexDocument,
      },
    });
  }

  // No stub — let the generic dispatch via `getContentFamily` and its own
  // registry. But this wrapper must stay PDF-only, so filter at the
  // `createExtractor` seam rather than pre-filtering attachments.
  return ingestGmailMediaAttachments({
    userId: args.userId,
    accountId: args.accountId,
    message: args.message,
    accessToken: args.accessToken,
    deps: {
      getAttachment: args.deps?.getAttachment,
      createExtractor: (opts) => {
        if (opts.family !== "pdf") return null;
        return createMediaExtractor("gmailAttachment", "pdf");
      },
      indexDocument: args.deps?.indexDocument,
    },
  });
}
