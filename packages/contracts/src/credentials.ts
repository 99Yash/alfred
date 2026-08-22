/**
 * How each integration's credential is stored and how "connected" is proved.
 *
 * This is one axis, declared once, because it was previously spelled three
 * times: the bearer-token persistence layer in `@alfred/integrations`
 * (`shared/credentials.ts`) narrowed its signatures with a hand-written
 * `["notion", "railway", "vercel"]`, and the Settings connectedness probe in
 * `apps/web` re-derived the same set inline as `backend === "notion" ||
 * backend === "railway" || backend === "vercel"` off a `Record<string, …>`
 * with no exhaustiveness at all. The server copy fails loudly (a missing
 * provider is a compile error at the first call site); the web copy fails
 * *silently* — an unlisted provider falls through to the scope-completeness
 * probe, which no bearer credential can ever satisfy, so a genuinely connected
 * account renders as "not connected".
 *
 * Exhaustive by construction, exactly like {@link GENERAL_INVOCATION_COVERAGE}:
 * `Record<LoadableIntegrationSlug, CredentialShape>` means adding a slug to
 * {@link LOADABLE_INTEGRATION_SLUGS} without declaring how its credential works
 * is a compile error, so the decision is forced at slug-add time rather than
 * discovered at first use.
 *
 * NOT the same axis as the web's `IntegrationBackend`, which names the route
 * family (`/integrations/<backend>/credentials`). The two overlap today by
 * coincidence — three bearer providers happen to have three route namespaces —
 * and would diverge the moment two providers shared one credential endpoint.
 */

import { z } from "zod";

import { enumGuard } from "./guards";
import {
  isLoadableIntegrationSlug,
  LOADABLE_INTEGRATION_SLUGS,
  type LoadableIntegrationSlug,
} from "./tools";

/**
 * - `google_oauth`: refresh-rotated OAuth grant. Connected iff an active
 *   credential carries every scope the feature needs — Google's consent screen
 *   lets the user uncheck individual scopes, so presence alone proves nothing.
 * - `github_app`: App installation (ADR-0052). App *permissions* never land in
 *   the credential's `scopes`, so connectedness is an active row with an
 *   `installation_id`; legacy classic-OAuth rows read as not-connected.
 * - `bearer`: one long-lived bearer token (Notion/Vercel OAuth, Railway pasted
 *   API token). No scopes and no installation to probe — an active row IS the
 *   proof.
 * - `deferred`: no credential store wired yet.
 * - `not_applicable`: no provider credential at all (iMessage is local ingest).
 */
export type CredentialShape =
  | "google_oauth"
  | "github_app"
  | "bearer"
  | "deferred"
  | "not_applicable";

export const CREDENTIAL_SHAPE = {
  gmail: "google_oauth",
  calendar: "google_oauth",
  drive: "google_oauth",
  docs: "google_oauth",
  sheets: "google_oauth",
  slides: "google_oauth",
  slack: "deferred",
  linear: "deferred",
  github: "github_app",
  notion: "bearer",
  railway: "bearer",
  vercel: "bearer",
  imessage: "not_applicable",
} as const satisfies Record<LoadableIntegrationSlug, CredentialShape>;

/**
 * The type-level subset whose access is a single long-lived bearer token — the
 * domain of the shared bearer persistence layer in `@alfred/integrations`.
 * Derived from the map, so it can never drift from it.
 */
export type BearerProvider = {
  [K in LoadableIntegrationSlug]: (typeof CREDENTIAL_SHAPE)[K] extends "bearer" ? K : never;
}[LoadableIntegrationSlug];

/** Runtime list of the bearer providers, derived from (and pinned to) the map. */
export const BEARER_PROVIDER_SLUGS: readonly BearerProvider[] = LOADABLE_INTEGRATION_SLUGS.filter(
  (slug): slug is BearerProvider => CREDENTIAL_SHAPE[slug] === "bearer",
);

export const isBearerProvider = enumGuard(BEARER_PROVIDER_SLUGS);

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
