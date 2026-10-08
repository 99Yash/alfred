import { getStringPath } from "@alfred/contracts";

import type { VercelTokenResult } from "./oauth";

/**
 * Vercel credential metadata: written at connect, read on every call. The writer and
 * reader once drifted (`team_id` vs `teamId`). A lost team scope is silent: Vercel
 * answers in personal scope with a 200 and an empty list.
 */

/** Named keys, so writer and reader cannot drift. */
export type VercelCredentialMetadata = {
  installation_id: string | null;
  configuration_id: string | null;
  /** Not `teamId`, which is the query-param form. */
  team_id: string | null;
  user_id: string | null;
};

const TEAM_ID_KEY = "team_id" satisfies keyof VercelCredentialMetadata;

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
  return getStringPath(metadata, TEAM_ID_KEY) || null;
}
