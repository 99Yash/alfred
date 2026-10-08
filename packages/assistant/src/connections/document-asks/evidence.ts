import { getContentFormat, type ContentFormat } from "@alfred/contracts";
import { sha256 } from "@alfred/corpus";
import { classifyGmailAttachmentContent } from "./classifier";

export interface DocumentAskOccurrence {
  attachmentId: string;
  filename: string | null;
  mimeType: string | null;
}

/** Positive evidence from one stored attachment. The reducer reclassifies stored content, so no payload carries a claim. */
export function projectDocumentAskEvidence(input: {
  documentId: string;
  content: string;
  contentHash: string;
  canonicalFormat: ContentFormat | null | undefined;
  canonicalMimeType: string | null | undefined;
  occurrence: DocumentAskOccurrence;
}) {
  const occurrenceFormat = input.occurrence.mimeType
    ? getContentFormat(input.occurrence.mimeType)
    : null;

  const mimeType = input.occurrence.mimeType ?? input.canonicalMimeType ?? null;

  const format =
    occurrenceFormat ?? input.canonicalFormat ?? (mimeType ? getContentFormat(mimeType) : null);

  if (!format || !input.content.trim() || !input.contentHash) return null;

  if (sha256(input.content) !== input.contentHash) return null;

  const contentKind = classifyGmailAttachmentContent({
    content: input.content,
    filename: input.occurrence.filename,
    mimeType: input.occurrence.mimeType,
    format,
  });

  if (!contentKind) return null;

  return {
    attachmentDocumentId: input.documentId,
    attachmentId: input.occurrence.attachmentId,
    contentHash: input.contentHash,
    format,
    contentKind,
  };
}

export type DocumentAskEvidence = NonNullable<ReturnType<typeof projectDocumentAskEvidence>>;

export function documentAskEvidenceKey(evidence: DocumentAskEvidence): string {
  return [evidence.attachmentDocumentId, evidence.attachmentId, evidence.contentHash].join(
    "\u0000",
  );
}
