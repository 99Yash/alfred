import { z } from "zod";
import {
  INBOUND_EVENT_SOURCES,
  isInboundEventSource,
  type InboundEventSource,
} from "./event-triggers";

/**
 * Providers that own a row in the shared documents corpus. Every member has a
 * writer: `gmail` and `gmail_attachment` are the mailbox ingest lanes, and each
 * inbound event source writes one document per receipt (#989, the corpus
 * receipt writer keys on `event_receipts.provider`). A new inbound source joins
 * this list by joining `EVENT_SOURCE_ENTRIES`; a provider with no writer is not
 * listed, so the enum and the CHECK it renders describe the traffic (#987).
 */
export const DOCUMENT_SOURCES = ["gmail", "gmail_attachment", ...INBOUND_EVENT_SOURCES] as const;

export const documentSourceSchema = z.enum(DOCUMENT_SOURCES);

export type DocumentSource = z.infer<typeof documentSourceSchema>;

/**
 * The provider record shape each direct-ingest document source writes into
 * `documents.source_id`, keyed by source (#1076).
 *
 * A source outside {@link INBOUND_EVENT_SOURCES} writes the provider's own id
 * there — a Gmail message id, a `messageId:attachmentId` attachment pair — so
 * that column is directly dereferenceable against the provider. The value here
 * names the record shape, and an expansion handle carries it as its `kind` so a
 * later live drill-down (#428) reads the shape from the record rather than from
 * a switch over source names.
 *
 * The key type is `Exclude<DocumentSource, InboundEventSource>`, so a new
 * direct-ingest lane must declare its record shape to compile, and a new
 * inbound source needs no edit here at all.
 */
const DOCUMENT_RECORD_KINDS = {
  gmail: "gmail_message",
  gmail_attachment: "gmail_attachment",
} as const satisfies Record<Exclude<DocumentSource, InboundEventSource>, string>;

/** A provider record shape one document source can address. */
export type DocumentRecordKind = (typeof DOCUMENT_RECORD_KINDS)[keyof typeof DOCUMENT_RECORD_KINDS];

/**
 * The provider record shape `documents.source_id` names for `source`, or `null`
 * when that column holds an id no provider can dereference.
 *
 * An inbound-webhook source keys its corpus row by Alfred's own receipt id
 * (`receiptDocumentKey` in `@alfred/assistant/connections/ingestion`), so its
 * `source_id` is an Alfred id that reads back only against Alfred's store. The
 * null answer is therefore derived from the writer's own rule rather than
 * restated per source, and it is what keeps a receipt-backed card on the
 * document-scoped handle it has today.
 */
export function documentRecordKind(source: DocumentSource): DocumentRecordKind | null {
  return isInboundEventSource(source) ? null : DOCUMENT_RECORD_KINDS[source];
}
