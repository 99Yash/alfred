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
 * Whether `documents.source_id` is a provider address for each direct-ingest
 * document source, and under which record shape (#1076).
 *
 * A non-null value names the record shape the provider can dereference, and an
 * expansion handle carries it as its `kind` so a later live drill-down (#428)
 * reads the shape from the record rather than from a switch over source names.
 * A null value means the column is not a faithful address for that source. The
 * answers today, and the reason behind each:
 *
 * - `gmail` writes the provider's own message id, so the row addresses exactly
 *   one Gmail message. `documents_source_id_idx` is unique on
 *   `(user_id, source, source_id)`, so the mapping stays one-to-one.
 * - `gmail_attachment` writes a `messageId:attachmentId` pair, but
 *   `documents_attachment_content_hash_idx` folds byte-identical content across
 *   every carrier into ONE row whose `source_id`, `account_id`, and
 *   `source_thread_id` name the FIRST carrier only. A handle minted from that
 *   row therefore points at a message the user may never have asked about, on
 *   an account that can be unlinked while a live twin exists. Per-carrier
 *   provenance rides `metadata.references` instead, which
 *   `parseAttachmentContentReferences` reads onto `SearchHit.occurrences` — one
 *   entry per carrier, each with its own message, thread, and account. An
 *   expander that wants an attachment's provider address reads that array and
 *   picks a carrier; it does not read the folded row's own id.
 *
 * The null is a property of the COLUMN, not of one row, so it is decided here
 * rather than by testing a row for occurrences at mint time. That reader drops
 * an entry it cannot parse, so a folded row can read as unfolded, and a rule
 * built on it would answer "faithful address" exactly when the evidence of the
 * fold went missing.
 *
 * The key type is `Exclude<DocumentSource, InboundEventSource>`, so a new
 * direct-ingest lane must state its answer to compile, and a new inbound source
 * needs no edit here at all.
 */
const DOCUMENT_RECORD_KINDS = {
  gmail: "gmail_message",
  gmail_attachment: null,
} as const satisfies Record<Exclude<DocumentSource, InboundEventSource>, string | null>;

/** A provider record shape one document source can address. */
export type DocumentRecordKind = NonNullable<
  (typeof DOCUMENT_RECORD_KINDS)[keyof typeof DOCUMENT_RECORD_KINDS]
>;

/**
 * The provider record shape `documents.source_id` names for `source`, or `null`
 * when that column is not a provider address.
 *
 * An inbound-webhook source keys its corpus row by Alfred's own receipt id
 * (`receiptDocumentKey` in `@alfred/assistant/connections/ingestion`), so its
 * `source_id` reads back only against Alfred's store. That null is derived from
 * the writer's own rule rather than restated per source. Every other null comes
 * from {@link DOCUMENT_RECORD_KINDS}, which records the per-source reasons.
 *
 * A null answer keeps the card on the document-scoped handle it has today, so
 * no card loses its handle either way.
 */
export function documentRecordKind(source: DocumentSource): DocumentRecordKind | null {
  return isInboundEventSource(source) ? null : DOCUMENT_RECORD_KINDS[source];
}
