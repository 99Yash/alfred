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
 * `gmail_attachment` rows with page offsets. The PDF-only restriction is the
 * `allowedFamilies: ["pdf"]` ledger, enforced inside `extraction()`; this file
 * adds no second extraction hook. New callers must not add PDF-specific hooks
 * here — add a family in `@alfred/contracts` and a `FAMILY_REGISTRY` entry in
 * `@alfred/extraction` instead.
 */
export async function ingestGmailPdfAttachments(
  args: GmailAttachmentIngestArgs,
): Promise<GmailAttachmentIngestResult> {
  return ingestGmailMediaAttachments({
    userId: args.userId,
    accountId: args.accountId,
    message: args.message,
    accessToken: args.accessToken,
    deps: {
      getAttachment: args.deps?.getAttachment,
      allowedFamilies: ["pdf"] as const,
      createExtractor: args.deps?.createExtractor,
      indexDocument: args.deps?.indexDocument,
    },
  });
}
