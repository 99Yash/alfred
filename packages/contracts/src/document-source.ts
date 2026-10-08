import { z } from "zod";
import { INBOUND_EVENT_SOURCES } from "./event-triggers";

/** Corpus providers. List only a provider that has a writer; inbound sources join through `EVENT_SOURCE_ENTRIES`. */
export const DOCUMENT_SOURCES = ["gmail", "gmail_attachment", ...INBOUND_EVENT_SOURCES] as const;

export const documentSourceSchema = z.enum(DOCUMENT_SOURCES);

export type DocumentSource = z.infer<typeof documentSourceSchema>;

/** `true` for a file row, `false` for a message row. A full record, so a new source must choose. */
const FILE_DOCUMENT_SOURCES = {
  gmail: false,
  gmail_attachment: true,
  github: false,
  sentry: false,
} satisfies Record<DocumentSource, boolean>;

export function isFileDocumentSource(source: DocumentSource): boolean {
  return FILE_DOCUMENT_SOURCES[source];
}
