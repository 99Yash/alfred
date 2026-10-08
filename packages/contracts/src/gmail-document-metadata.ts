import { z } from "zod";
import { contentFormatSchema } from "./attachments";
import { isRecord } from "./guards";

const nullableStringField = z.string().nullable().optional();

const labelIdsField = z.array(z.string()).optional();

const isSentField = z.boolean().optional();

const optionalIdentifierField = z.string().min(1).nullable().optional();

const optionalFormatField = contentFormatSchema.optional();

/**
 * Gmail fields in `documents.metadata`. Loose, so other writers' keys survive.
 * The schema is strict for writers; the parser below drops a bad field on a legacy row.
 */
export const gmailDocumentMetadataSchema = z.looseObject({
  from: nullableStringField,
  to: nullableStringField,
  cc: nullableStringField,
  snippet: nullableStringField,
  labelIds: labelIdsField,
  isSent: isSentField,
  /** Gmail's millisecond timestamp. Absent on legacy rows. */
  internalDate: z.string().min(1).nullable().optional(),
  /** The message that first carried a `gmail_attachment` row. */
  messageId: optionalIdentifierField,
  attachmentId: optionalIdentifierField,
  threadId: optionalIdentifierField,
  accountId: optionalIdentifierField,
  filename: z.string().min(1).nullable().optional(),
  mimeType: z.string().min(1).nullable().optional(),
  format: optionalFormatField,
});

export type GmailDocumentMetadata = z.infer<typeof gmailDocumentMetadataSchema>;

type GmailDocumentMetadataKey = keyof typeof gmailDocumentMetadataSchema.shape;

/** Parse persisted Gmail metadata into its canonical typed view. */
export function parseGmailDocumentMetadata(raw: unknown): GmailDocumentMetadata {
  const candidate = isRecord(raw) ? { ...raw } : {};
  repairPersistedField(candidate, "from", nullableStringField);
  repairPersistedField(candidate, "to", nullableStringField);
  repairPersistedField(candidate, "cc", nullableStringField);
  repairPersistedField(candidate, "snippet", nullableStringField);
  repairPersistedField(candidate, "labelIds", labelIdsField);
  repairPersistedField(candidate, "isSent", isSentField);
  repairPersistedField(candidate, "internalDate", z.string().min(1).nullable());
  repairPersistedField(candidate, "messageId", optionalIdentifierField);
  repairPersistedField(candidate, "attachmentId", optionalIdentifierField);
  repairPersistedField(candidate, "threadId", optionalIdentifierField);
  repairPersistedField(candidate, "accountId", optionalIdentifierField);
  repairPersistedField(candidate, "filename", z.string().min(1).nullable().optional());
  repairPersistedField(candidate, "mimeType", z.string().min(1).nullable().optional());
  repairPersistedField(candidate, "format", optionalFormatField);

  return gmailDocumentMetadataSchema.parse(candidate);
}

const SENT_LABEL = "SENT";

/** True when the metadata marks an authenticated sent message. */
export function isSentGmailMetadata(metadata: unknown): boolean {
  const parsed = parseGmailDocumentMetadata(metadata);

  return parsed.isSent === true || parsed.labelIds?.some((label) => label === SENT_LABEL) === true;
}

/**
 * Read the mail that first carried a `gmail_attachment` row. Older rows fall back
 * to the row's own columns, and `messageId`/`attachmentId` stay null.
 * Ingest and the document-ask reducer share this so they agree.
 */
export function readGmailAttachmentFirstCarrier(row: {
  accountId: string | null;
  sourceThreadId: string | null;
  metadata: unknown;
}) {
  const metadata = parseGmailDocumentMetadata(row.metadata);

  return {
    messageId: metadata.messageId ?? null,
    attachmentId: metadata.attachmentId ?? null,
    accountId: metadata.accountId ?? row.accountId,
    threadId: metadata.threadId ?? row.sourceThreadId,
  };
}

function repairPersistedField(
  candidate: Record<string, unknown>,
  key: GmailDocumentMetadataKey,
  schema: z.ZodType<unknown>,
): void {
  if (!(key in candidate)) return;

  if (!schema.validate(candidate[key])) delete candidate[key];
}
