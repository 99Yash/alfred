import { z } from "zod";
import { attachmentContentReferenceSchema } from "./attachment-content-references";
import { contentFormatSchema } from "./attachments";
import { documentPagesMixedSchema } from "./document-pages";
import { parsePersistedMetadata } from "./persisted-metadata";

const nullableStringField = z.string().nullable().optional();

const optionalIdentifierField = z.string().min(1).nullable().optional();

/**
 * `documents.metadata` on a `gmail` (mail) row. Loose, so keys from a raw SQL merge or an older
 * deploy survive. Strict for writers; the read parse drops a bad field on a legacy row.
 *
 * Branded on output: `.$type<>()` makes the raw column a union of loose objects, and a loose
 * object is assignable to every arm, so without one brand per arm a mail value would compile
 * where an attachment value is required. The brand literal is named by no call site.
 */
export const gmailDocumentMetadataSchema = z
  .looseObject({
    from: nullableStringField,
    to: nullableStringField,
    cc: nullableStringField,
    snippet: nullableStringField,
    labelIds: z.array(z.string()).optional(),
    isSent: z.boolean().optional(),
    /** Gmail's millisecond timestamp. Absent on legacy rows. */
    internalDate: z.string().min(1).nullable().optional(),
    historyId: z.string().min(1).nullable().optional(),
    sizeEstimate: z.number().nullable().optional(),
    /** Set by `setMediaPending` while the mail's attachments wait for extraction. */
    mediaPending: z.boolean().optional(),
  })
  .brand<"ParsedGmailDocumentMetadata">();

export type GmailDocumentMetadata = z.output<typeof gmailDocumentMetadataSchema>;

/**
 * `documents.metadata` on a `gmail_attachment` row: the mail that first carried the content,
 * page offsets (ADR-0091 D6), and the later carriers in `references`. Brand is its own
 * literal (see the mail arm): a parsed mail value must not compile as a parsed attachment.
 */
export const gmailAttachmentMetadataSchema = z
  .looseObject({
    messageId: optionalIdentifierField,
    attachmentId: optionalIdentifierField,
    threadId: optionalIdentifierField,
    accountId: optionalIdentifierField,
    filename: z.string().min(1).nullable().optional(),
    mimeType: z.string().min(1).nullable().optional(),
    format: contentFormatSchema.optional(),
    size: z.number().optional(),
    /** Offset pages; older rows can hold legacy `{page,text}` entries. */
    pages: documentPagesMixedSchema.optional(),
    /** Another arrival of the same content. A bad entry is dropped and the rest are kept. */
    references: z
      .array(z.unknown())
      .transform((entries) =>
        entries.flatMap((entry) => {
          const parsed = attachmentContentReferenceSchema.safeParse(entry);

          return parsed.success ? [parsed.data] : [];
        }),
      )
      .optional(),
  })
  .brand<"ParsedGmailAttachmentMetadata">();

export type GmailAttachmentMetadata = z.output<typeof gmailAttachmentMetadataSchema>;

/** Parse persisted mail metadata into its canonical typed view. */
export function parseGmailDocumentMetadata(raw: unknown): GmailDocumentMetadata {
  return parsePersistedMetadata(gmailDocumentMetadataSchema, raw);
}

/** Parse persisted attachment metadata into its canonical typed view. */
export function parseGmailAttachmentMetadata(raw: unknown): GmailAttachmentMetadata {
  return parsePersistedMetadata(gmailAttachmentMetadataSchema, raw);
}

const SENT_LABEL = "SENT";

/** True when the metadata marks an authenticated sent message. */
export function isSentGmailMetadata(metadata: GmailDocumentMetadata): boolean {
  return (
    metadata.isSent === true || metadata.labelIds?.some((label) => label === SENT_LABEL) === true
  );
}

/**
 * Read the mail that first carried a `gmail_attachment` row. Older rows fall back
 * to the row's own columns, and `messageId`/`attachmentId` stay null.
 * Ingest and the document-ask reducer share this so they agree.
 */
export function readGmailAttachmentFirstCarrier(row: {
  accountId: string | null;
  sourceThreadId: string | null;
  metadata: GmailAttachmentMetadata;
}) {
  return {
    messageId: row.metadata.messageId ?? null,
    attachmentId: row.metadata.attachmentId ?? null,
    accountId: row.metadata.accountId ?? row.accountId,
    threadId: row.metadata.threadId ?? row.sourceThreadId,
  };
}
