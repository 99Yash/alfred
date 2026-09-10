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
