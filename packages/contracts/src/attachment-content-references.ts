import { z } from "zod";

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
