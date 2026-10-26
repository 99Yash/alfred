import { parsePersistedMetadata } from "@alfred/contracts";
import { z } from "zod";

/**
 * `integration_credentials.metadata` on a Google row. Connect writes `googleHostedDomain`, the
 * watch install merges `watch`, and the label caches `jsonb_set` their own key, so the read parse
 * is lenient per key: a bad field reads as absent and the rest of the row survives.
 */

const gmailWatchStateSchema = z.object({
  topic: z.string().min(1),
  expiresAt: z.iso.datetime(),
  /** The `historyId` from the watch call. The cold-start cursor. */
  baselineHistoryId: z.string().min(1),
  /** A renewal must not reset this: push health reads it. */
  installedAt: z.iso.datetime(),
  /** Absent on older rows. */
  renewedAt: z.iso.datetime().optional(),
});

export type GmailWatchState = z.infer<typeof gmailWatchStateSchema>;

const alfredLabelsCacheSchema = z.object({
  /** Keyed by triage category. A category added since the cache was written forces a refresh. */
  byCategory: z.record(z.string(), z.string().min(1)),
  allIds: z.array(z.string()).optional(),
  cachedAt: z.string().optional(),
});

const alfredSelfLabelCacheSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  cachedAt: z.string().optional(),
});

const googleCredentialMetadataSchema = z
  .looseObject({
    /** The Workspace `hd` claim from connect. */
    googleHostedDomain: z.string().min(1).optional(),
    watch: gmailWatchStateSchema.optional(),
    alfredLabels: alfredLabelsCacheSchema.optional(),
    alfredSelfLabel: alfredSelfLabelCacheSchema.optional(),
  })
  .brand<"ParsedGoogleCredentialMetadata">();

export type GoogleCredentialMetadataInput = z.input<typeof googleCredentialMetadataSchema>;

export type GoogleCredentialMetadata = z.output<typeof googleCredentialMetadataSchema>;

/** Parse a stored Google credential's metadata into its canonical typed view. */
export function parseGoogleCredentialMetadata(raw: unknown): GoogleCredentialMetadata {
  return parsePersistedMetadata(googleCredentialMetadataSchema, raw);
}
