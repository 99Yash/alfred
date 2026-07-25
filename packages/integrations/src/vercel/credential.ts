import { getStringPath } from "@alfred/contracts";

import type { VercelTokenResult } from "./oauth";

/**
 * The Vercel credential's persisted metadata — written once at connect, read on
 * every API call. Both directions live in this file because they had already
 * drifted: the connect route persists Vercel's own `team_id` spelling while a
 * reader looked for `teamId`.
 *
 * That class of bug is worth the module. A dropped team scope is INVISIBLE —
 * Vercel answers a team token that carries no `?teamId=` in *personal-account*
 * scope, with a `200` and an empty list. So the failure surfaces to the model as
 * a confident "you have no projects", not as an auth error. There is no status
 * code to notice and nothing to retry.
 */

/**
 * The persisted shape, declared once. A `Record<string, string | null>` return
 * type — what the builder used to have — pins no key names at all: renaming
 * `team_id` to `teamId` in the builder below would still compile, which is
 * exactly the drift this module exists to prevent. Naming the keys in a type
 * makes the writer and the reader two projections of one declaration rather
 * than two hand-matched spellings that merely live in the same file.
 */
export type VercelCredentialMetadata = {
  installation_id: string | null;
  configuration_id: string | null;
  /** Vercel's own spelling — NOT `teamId`, which is the query-param form. */
  team_id: string | null;
  user_id: string | null;
};

/** The one key the reader digs for, pinned to the writer's declaration. */
const TEAM_ID_KEY = "team_id" satisfies keyof VercelCredentialMetadata;

/**
 * Build the metadata to persist at connect. Takes the exchange result so the
 * spelling of every key is decided here and nowhere else.
 */
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
 * The team scope a team install must echo as `?teamId=` on every call, or `null`
 * for a personal install (which has no team and must send no `teamId`).
 *
 * Takes `unknown`, not {@link VercelCredentialMetadata}, and that is deliberate:
 * the value is persisted jsonb whose column type is itself only an assertion,
 * and rows written by older code can hold any shape. Narrowing the parameter
 * would claim a guarantee the storage does not make. Validation belongs here, at
 * the read boundary.
 */
export function readVercelTeamId(metadata: unknown): string | null {
  return getStringPath(metadata, TEAM_ID_KEY) || null;
}
