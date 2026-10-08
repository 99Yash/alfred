import { z } from "zod";
import { isRecord } from "./guards";

/**
 * Another arrival of the same attachment content under a different message.
 * `mimeType` is optional because old entries lack it.
 */
export const attachmentContentReferenceSchema = z.object({
  messageId: z.string().min(1),
  attachmentId: z.string().min(1),
  threadId: z.string().nullable(),
  accountId: z.string().nullable(),
  filename: z.string().min(1),
  mimeType: z.string().optional(),
  size: z.number(),
  /** ISO time of the carrying mail. */
  authoredAt: z.string().nullable(),
});

export type AttachmentContentReference = z.infer<typeof attachmentContentReferenceSchema>;

/** Read `metadata.references`. Drops a bad entry and keeps the rest. */
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
