import { z } from "zod";
import { INBOUND_EVENT_SOURCES } from "./event-triggers";

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
 * Corpus sources whose rows are FILES rather than messages (#429).
 *
 * The corpus holds two shapes of record under one table. A `gmail` row is the
 * body of a message somebody wrote; a `gmail_attachment` row is a file that
 * travelled with one. The distinction is what a card's modality turns on — a
 * message body is `text`, a file is a `document` — so it is stated once here
 * instead of being re-derived from a slug at each reader.
 *
 * Exhaustive over `DocumentSource` rather than a partial set, so a new source
 * fails the typecheck here instead of degrading in silence to `text`: a future
 * Drive or Slack file lane answers `true`, and a message lane answers `false`.
 */
const FILE_DOCUMENT_SOURCES = {
  gmail: false,
  gmail_attachment: true,
  github: false,
  sentry: false,
} satisfies Record<DocumentSource, boolean>;

/** Whether this corpus source writes a file row rather than a message row. */
export function isFileDocumentSource(source: DocumentSource): boolean {
  return FILE_DOCUMENT_SOURCES[source];
}
