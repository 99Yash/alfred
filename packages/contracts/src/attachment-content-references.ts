import { z } from "zod";
import { isRecord } from "./guards";

/**
 * One recorded occurrence of a canonical `gmail_attachment` document's
 * content arriving under a different `messageId:attachmentId`. The writer is
 * the Gmail media ingest, which appends entries to the canonical row's
 * `metadata.references`; this schema is the shared contract so retrieval can
 * validate the persisted jsonb instead of trusting it.
 *
 * `mimeType` is optional because entries written before #878 lack it: a fold
 * keeps identical extracted text as one logical document, and each occurrence
 * now names its format so a folded `.txt`/`.pdf` twin stays traceable.
 */
export const attachmentContentReferenceSchema = z.object({
  messageId: z.string().min(1),
  attachmentId: z.string().min(1),
  threadId: z.string().nullable(),
  /** Carrying account, when the ingest knew it — folds across linked accounts stay attributable. */
  accountId: z.string().nullable(),
  filename: z.string().min(1),
  mimeType: z.string().optional(),
  size: z.number(),
  /** ISO instant of the carrying mail's Date, or null when unknown. */
  authoredAt: z.string().nullable(),
});

export type AttachmentContentReference = z.infer<typeof attachmentContentReferenceSchema>;

/**
 * Lenient reader for the persisted `metadata.references` array on a
 * `gmail_attachment` document row. The column is unknown jsonb shared with
 * other features' keys, so this takes the raw metadata value, validates each
 * array element against {@link attachmentContentReferenceSchema}, and drops an
 * invalid entry without discarding its valid peers.
 */
export function parseAttachmentContentReferences(
  rawDocumentMetadata: unknown,
): AttachmentContentReference[] {
  if (!isRecord(rawDocumentMetadata)) return [];
  const references = rawDocumentMetadata.references;
  if (!Array.isArray(references)) return [];
  const parsed: AttachmentContentReference[] = [];
  for (const entry of references) {
    const result = attachmentContentReferenceSchema.safeParse(entry);
    if (result.success) parsed.push(result.data);
  }
  return parsed;
}
