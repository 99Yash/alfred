import { parsePersistedMetadata } from "@alfred/contracts";
import { z } from "zod";

import type { VercelTokenResult } from "./oauth";

/**
 * Vercel credential metadata: written at connect, read on every call. The writer and
 * reader once drifted (`team_id` vs `teamId`). A lost team scope is silent: Vercel
 * answers in personal scope with a 200 and an empty list.
 */

/** One schema for the writer and the reader, so the keys cannot drift. */
const vercelCredentialMetadataSchema = z.object({
  installation_id: z.string().nullable(),
  configuration_id: z.string().nullable(),
  /** Not `teamId`, which is the query-param form. */
  team_id: z.string().min(1).nullable(),
  user_id: z.string().nullable(),
});

type VercelCredentialMetadata = z.input<typeof vercelCredentialMetadataSchema>;

/** Older rows can lack any key, so the read arm makes each one optional. */
const storedVercelCredentialMetadataSchema = vercelCredentialMetadataSchema
  .partial()
  .brand<"ParsedVercelCredentialMetadata">();

export function vercelCredentialMetadata(args: {
  tokens: VercelTokenResult;
  configurationId: string | null;
}): VercelCredentialMetadata {
  return {
    installation_id: args.tokens.installationId,
    configuration_id: args.configurationId,
    team_id: args.tokens.teamId,
    user_id: args.tokens.userId,
  };
}

/**
 * `null` for a personal install, which must send no `teamId`.
 * Takes `unknown`: older rows can hold any shape.
 */
export function readVercelTeamId(metadata: unknown): string | null {
  return parsePersistedMetadata(storedVercelCredentialMetadataSchema, metadata).team_id ?? null;
}
