import { HttpError } from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { z } from "zod";

import { authedJson } from "../shared/authed-json";
import { getActiveBearerCredential } from "../shared/credentials";
import type { ProviderBindOptions } from "../shared/provider";
import { restPassthroughCapability, type RestPassthroughProfile } from "../shared/rest-passthrough";
import type { RetryPolicy } from "../shared/retry";

/**
 * Sentry REST API client (https://docs.sentry.io/api/). Access is an *internal
 * integration* token: the operator creates one internal integration in the
 * Sentry organization (Settings → Developer Settings), and that integration
 * issues the token the user pastes into Alfred. The same integration is the
 * sender the Sentry ingress descriptor (#563, the next slice) will verify, which
 * is why the connect flow records its installation. Internal-integration tokens do not expire
 * and cannot be refreshed, so the credential is a plain bearer token via the
 * shared bearer-credential layer.
 *
 * `SENTRY_INTEGRATION_SLUG` names that integration. The connect flow uses it to
 * find the integration's *installation* in the organization the user names,
 * because a webhook delivery identifies its installation only by `installation.uuid`
 * (verified against `sentry_app_installation.py` in getsentry/sentry, 2026-09-05:
 * the installations list returns `app.slug`, `uuid`, and `status`). The uuid is
 * stored in `integration_credentials.installation_id`, the column that already
 * joins a GitHub delivery to its credential, so the Sentry descriptor's
 * `resolveOwner` will be the same indexed lookup, scoped by provider.
 */

const SENTRY_API = "https://sentry.io/api/0";

export interface SentryIntegrationConfig {
  /** The internal integration's slug, as shown in its Developer Settings URL. */
  integrationSlug: string;
}

export function getSentryIntegrationConfig(): SentryIntegrationConfig {
  const env = serverEnv();
  if (!env.SENTRY_INTEGRATION_SLUG) {
    throw new Error("[sentry] Sentry is not configured — set SENTRY_INTEGRATION_SLUG");
  }
  return { integrationSlug: env.SENTRY_INTEGRATION_SLUG };
}

export function isSentryConfigured(): boolean {
  try {
    getSentryIntegrationConfig();
    return true;
  } catch {
    return false;
  }
}

/** A pasted token is wrong iff Sentry says so; a 5xx or a timeout is not the user's fault. */
export function isSentryAuthorizationError(err: unknown): boolean {
  return err instanceof HttpError && (err.status === 401 || err.status === 403);
}

function sentryHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

/**
 * Transport profile for the general read-only passthrough tier (ADR-0074): the
 * pinned Sentry REST authority and bearer auth. The `/api/0` namespace is part
 * of the base URL, so the model's path starts at `/organizations/...`.
 */
function sentryPassthroughProfile(token: string): RestPassthroughProfile {
  return { baseUrl: SENTRY_API, headers: sentryHeaders(token) };
}

async function sentryGet(token: string, path: string): Promise<unknown> {
  return authedJson(
    { headers: sentryHeaders(token) },
    { url: `${SENTRY_API}${path}` },
    { provider: "sentry", urlLabel: path, bodyPolicy: "summarize" },
  );
}

const organizationSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
});

export type SentryOrganization = z.infer<typeof organizationSchema>;

const installationsSchema = z.array(
  z.object({
    app: z.object({ slug: z.string() }),
    uuid: z.string(),
    status: z.string(),
  }),
);

export interface SentryConnection {
  organization: SentryOrganization;
  /** The installation uuid every webhook delivery from this organization carries. */
  installationUuid: string;
}

/**
 * Why a token that Sentry accepted still cannot be stored: the configured
 * integration is not installed in the organization the user named. An
 * authorization failure is a different arm (`isSentryAuthorizationError`).
 */
export class SentryInstallationNotFoundError extends Error {
  readonly _tag = "SentryInstallationNotFoundError" as const;
  constructor(organization: string, integrationSlug: string) {
    super(
      `[sentry] integration '${integrationSlug}' is not installed in organization '${organization}'`,
    );
    this.name = "SentryInstallationNotFoundError";
  }
}

/**
 * Validate a pasted internal-integration token for one organization and
 * resolve the installation it belongs to. Two reads, both `org:read`:
 *
 *   GET /organizations/{slug}/                          the identity the credential stores
 *   GET /organizations/{slug}/sentry-app-installations/ the installation uuid webhooks carry
 *
 * An internal integration is installed on exactly one organization, so the
 * match on `app.slug` is at most one row. `GET /organizations/` (no slug) is
 * not used: Sentry answers it only for a *user* token, not an integration token.
 */
export async function sentryValidateToken(args: {
  token: string;
  organization: string;
}): Promise<SentryConnection> {
  const { integrationSlug } = getSentryIntegrationConfig();
  const slug = encodeURIComponent(args.organization);
  const organization = organizationSchema.parse(
    await sentryGet(args.token, `/organizations/${slug}/`),
  );
  const installations = installationsSchema.parse(
    await sentryGet(args.token, `/organizations/${slug}/sentry-app-installations/`),
  );
  const installation = installations.find(
    (row) => row.app.slug === integrationSlug && row.status === "installed",
  );
  if (!installation) throw new SentryInstallationNotFoundError(organization.slug, integrationSlug);
  return { organization, installationUuid: installation.uuid };
}

/** Resolves fresh bearer auth per call; the client stores this, not a credential. */
export interface SentryAuthResolver {
  (): Promise<{ token: string }>;
}

export interface SentryClientOptions {
  resolveAuth: SentryAuthResolver;
  /** Transient-retry envelope for retry-safe requests, or `"none"`. See `ProviderBindOptions.retry`. */
  retry: RetryPolicy | "none";
}

/**
 * A Sentry client bound to an auth *resolver*. Its only surface today is the
 * passthrough transport profile: the curated reads this provider will grow
 * (`GET /issues/{id}/`, `.../events/{event_id}/`) arrive with the consumer that
 * needs them (the Seer pull-request verifier, #567), not ahead of it.
 */
export function createSentryClient(options: SentryClientOptions) {
  const passthrough = restPassthroughCapability({
    slug: "sentry",
    retry: options.retry,
    resolveProfile: async () => sentryPassthroughProfile((await options.resolveAuth()).token),
  });
  return {
    /**
     * Transport profile for the general read-only passthrough tier (ADR-0074):
     * pinned authority as data, so the passthrough tool never holds a credential.
     * The read gate is policy owned by `@alfred/assistant`, not this client.
     */
    passthrough,
  };
}

export type SentryClient = ReturnType<typeof createSentryClient>;

/** The call-site entry: a Sentry client for a user, resolving the active bearer credential per request. */
export function sentryClientForUser(options: ProviderBindOptions): SentryClient {
  const { userId, retry } = options;
  const resolveAuth = async () => {
    const cred = await getActiveBearerCredential(userId, "sentry", options.accountRef);
    return { token: cred.accessToken };
  };
  return createSentryClient({ resolveAuth, retry });
}
