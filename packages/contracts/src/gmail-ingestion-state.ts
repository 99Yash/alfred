import { z } from "zod";
import { parsePersistedMetadata } from "./persisted-metadata";

/**
 * `ingestion_state.state` on the Gmail `messages` stream: the history cursor and the
 * coverage-gap flag. The raw SQL compare-and-advance in `gmail-ingest.ts` writes the same two
 * keys with `jsonb_set`, so the read parse is lenient per key: a bad field reads as absent.
 *
 * Branded on output so a consumer holds a parsed value, never the raw column.
 */
export const gmailIngestionStateSchema = z
  .looseObject({
    historyId: z.string().min(1).nullable().optional(),
    coverageGap: z.boolean().optional(),
  })
  .brand<"ParsedGmailIngestionState">();

export type GmailIngestionStateInput = z.input<typeof gmailIngestionStateSchema>;

export type GmailIngestionState = z.output<typeof gmailIngestionStateSchema>;

/** Parse a persisted Gmail ingestion state into its canonical typed view. */
export function parseGmailIngestionState(raw: unknown): GmailIngestionState {
  return parsePersistedMetadata(gmailIngestionStateSchema, raw);
}
