import { z } from "zod";
import type { DocumentSource } from "./document-source";
import {
  parseGmailAttachmentMetadata,
  parseGmailDocumentMetadata,
  type GmailAttachmentMetadata,
  type GmailDocumentMetadata,
  type gmailAttachmentMetadataSchema,
  type gmailDocumentMetadataSchema,
} from "./gmail-document-metadata";
import { parsePersistedMetadata } from "./persisted-metadata";

/**
 * `documents.metadata` on an inbound receipt row (ADR-0090). Legacy and smoke rows hold `{}`.
 * Own brand literal (see the mail arm in `gmail-document-metadata.ts`).
 */
export const receiptDocumentMetadataSchema = z
  .looseObject({
    kind: z.string().min(1).optional(),
    summary: z.string().nullable().optional(),
  })
  .brand<"ParsedReceiptDocumentMetadata">();

export type ReceiptDocumentMetadata = z.output<typeof receiptDocumentMetadataSchema>;

/** Every source names its metadata arm. A new `DocumentSource` does not compile until it does. */
type DocumentMetadataArms = {
  gmail: GmailDocumentMetadata;
  gmail_attachment: GmailAttachmentMetadata;
  github: ReceiptDocumentMetadata;
  sentry: ReceiptDocumentMetadata;
};

/** The write shape of `documents.metadata`: any arm's input. Drizzle `$type` uses it. */
export type DocumentMetadataInput =
  | z.input<typeof gmailDocumentMetadataSchema>
  | z.input<typeof gmailAttachmentMetadataSchema>
  | z.input<typeof receiptDocumentMetadataSchema>;

/** A row's metadata, discriminated by `source`: narrow on `.source`, then `.metadata` is that arm. */
export type TypedDocumentMetadata<S extends DocumentSource = DocumentSource> =
  S extends DocumentSource ? { source: S; metadata: DocumentMetadataArms[S] } : never;

/**
 * Read `documents.metadata` through the arm that `documents.source` selects. A missing or bad
 * field reads as absent. Raw SQL merges write the column without a parse, so read through this.
 */
export function parseDocumentMetadata<S extends DocumentSource>(row: {
  source: S;
  metadata: unknown;
}): TypedDocumentMetadata<S>;
export function parseDocumentMetadata(row: {
  source: DocumentSource;
  metadata: unknown;
}): TypedDocumentMetadata {
  switch (row.source) {
    case "gmail":
      return { source: row.source, metadata: parseGmailDocumentMetadata(row.metadata) };
    case "gmail_attachment":
      return { source: row.source, metadata: parseGmailAttachmentMetadata(row.metadata) };
    case "github":
    case "sentry":
      return {
        source: row.source,
        metadata: parsePersistedMetadata(receiptDocumentMetadataSchema, row.metadata),
      };
    default: {
      const exhaustive: never = row.source;
      throw new Error(`[documents] unknown source ${String(exhaustive)}`);
    }
  }
}
