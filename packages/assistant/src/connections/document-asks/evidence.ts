import {
  documentAskEvidenceSchema,
  getContentFormat,
  type ContentFormat,
  type DocumentAskEvidence,
} from "@alfred/contracts";
import { sha256 } from "@alfred/corpus";
import { classifyGmailAttachmentContent } from "./classifier";

export interface DocumentAskOccurrence {
  attachmentId: string;
  filename: string | null;
  mimeType: string | null;
}

export function documentAskEvidenceKey(evidence: DocumentAskEvidence): string {
  return [evidence.attachmentDocumentId, evidence.attachmentId, evidence.contentHash].join(
    "\u0000",
  );
}

/**
 * Project one validated persisted occurrence into the reducer's evidence
 * contract. The producer and verifier share this boundary so format fallback,
 * hash validation, semantic classification, and evidence identity cannot drift.
 */
export function projectDocumentAskEvidence(input: {
  documentId: string;
  content: string;
  contentHash: string;
  canonicalFormat: ContentFormat | null | undefined;
  canonicalMimeType: string | null | undefined;
  occurrence: DocumentAskOccurrence;
  formatOverride?: ContentFormat | undefined;
}): DocumentAskEvidence | null {
  const occurrenceFormat = input.occurrence.mimeType
    ? getContentFormat(input.occurrence.mimeType)
    : null;

  const mimeType = input.occurrence.mimeType ?? input.canonicalMimeType ?? null;

  const format =
    input.formatOverride ??
    occurrenceFormat ??
    input.canonicalFormat ??
    (mimeType ? getContentFormat(mimeType) : null);

  if (!format || !input.content.trim() || !input.contentHash) return null;

  if (sha256(input.content) !== input.contentHash) return null;

  const contentKind = classifyGmailAttachmentContent({
    content: input.content,
    filename: input.occurrence.filename,
    mimeType: input.occurrence.mimeType,
    format,
  });

  if (!contentKind) return null;

  return documentAskEvidenceSchema.parse({
    attachmentDocumentId: input.documentId,
    attachmentId: input.occurrence.attachmentId,
    filename: input.occurrence.filename,
    mimeType: input.occurrence.mimeType,
    contentHash: input.contentHash,
    format,
    extraction: "extracted",
    contentKind,
    evidence: "extracted_content",
  });
}
