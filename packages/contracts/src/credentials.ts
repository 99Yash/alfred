/**
 * The credential wire shape of the http↔web seam. How each integration's
 * credential is stored and how "connected" is proved is a fact about the
 * integration, so it lives on the registry entry (`INTEGRATIONS[slug].credential`
 * in `./integrations`, ADR-0093); the bearer subset (`BearerSlug`,
 * `BEARER_PROVIDER_SLUGS`, `isBearerProvider`) is derived there.
 */

import { z } from "zod";

/**
 * The wire shape every `GET /integrations/<backend>/credentials` route returns.
 * One owning schema for the http↔web seam: the route handlers map their Drizzle
 * projections through {@link rowToCredentialWire} (which also pins the select
 * columns at compile time), and `apps/web` derives its connectedness projection
 * from this schema instead of restating the fields.
 *
 * Timestamps are ISO strings, not `Date`s — this describes the serialized JSON
 * body, not the database row.
 */
export const credentialRowSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  accountLabel: z.string().nullable(),
  status: z.string(),
  scopes: z.array(z.string()),
  installationId: z.string().nullable().optional(),
  expiresAt: z.string().nullable(),
  lastRefreshedAt: z.string().nullable(),
  createdAt: z.string(),
});

export type CredentialRowWire = z.infer<typeof credentialRowSchema>;

/**
 * Map a credential row (Drizzle timestamps still intact) onto
 * {@link CredentialRowWire}. Pure and browser-safe; serializing through here
 * keeps every producer's JSON identical and turns a column rename on the
 * producing side into a compile error instead of a silent field drop.
 */
export function rowToCredentialWire(row: {
  id: string;
  accountId: string;
  accountLabel: string | null;
  status: string;
  scopes: readonly string[];
  installationId?: string | null;
  expiresAt: Date | null;
  lastRefreshedAt: Date | null;
  createdAt: Date;
}): CredentialRowWire {
  return {
    id: row.id,
    accountId: row.accountId,
    accountLabel: row.accountLabel,
    status: row.status,
    scopes: [...row.scopes],
    installationId: row.installationId ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastRefreshedAt: row.lastRefreshedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
