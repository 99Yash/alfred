/**
 * The credential wire shape every `GET /integrations/<provider>/credentials`
 * route returns, plus the one dynamic reader of the credential-shape
 * projection. How each integration's credential is stored and how "connected"
 * is proved is a fact about the integration, so it lives on the registry entry
 * (`INTEGRATIONS[slug].credential` in `./integrations`, ADR-0093). The tables
 * this module used to hand-type (`CREDENTIAL_SHAPE`, `BEARER_PROVIDER_SLUGS`,
 * `isBearerProvider`) are projections there and reach consumers through the
 * root barrel; only the `BearerProvider` alias stays here.
 */

import { z } from "zod";

import {
  CREDENTIAL_SHAPE,
  isLoadableIntegrationSlug,
  type BearerSlug,
  type CredentialShape,
} from "./integrations";

/**
 * The slugs whose access is a single long-lived bearer token — the domain of
 * the shared bearer persistence layer in `@alfred/integrations`. The registry
 * name is {@link BearerSlug}; this alias keeps the older import working and is
 * deleted in PR 4 of the registry plan with the other transition names.
 */
export type BearerProvider = BearerSlug;

/**
 * The credential shape for a dynamic slug string (a UI catalog id, a persisted
 * value), or `undefined` when it isn't a loadable integration at all. Callers
 * treat `undefined` the same as `deferred`: nothing to probe.
 */
export function credentialShapeForSlug(slug: string): CredentialShape | undefined {
  return isLoadableIntegrationSlug(slug) ? CREDENTIAL_SHAPE[slug] : undefined;
}

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
