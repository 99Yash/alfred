import { HttpError } from "@alfred/contracts";
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
 * issues the token the user pastes into Alfred. The same integration signs the
 * webhooks the `sentry` ingress descriptor verifies (#563). Internal-integration
 * tokens do not expire and cannot be refreshed, so the credential is a plain
 * bearer token via the shared bearer-credential layer.
 *
 * The connect flow stores the organization the token reads, and nothing about
 * the integration's installation. An integration token cannot read
 * `/organizations/{slug}/sentry-app-installations/`: Sentry resolves that
 * endpoint's organization through the caller's memberships, and the
 * integration's proxy user has none, so it answers 404 "Could not find
 * requested organization" (verified live 2026-09-06 on both `sentry.io` and the
 * `de.sentry.io` region). A webhook delivery is attributed by its signature
 * instead: one Client Secret is one integration in one organization.
 */

const SENTRY_API = "https://sentry.io/api/0";

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

export interface SentryConnection {
  organization: SentryOrganization;
}

/**
 * Validate a pasted internal-integration token for one organization. One
 * `org:read` read, `GET /organizations/{slug}/`, gives the identity the
 * credential stores. `GET /organizations/` (no slug) is not used: Sentry answers
 * it only for a *user* token, not an integration token. The installation list
 * is not read either; see the module comment.
 */
export async function sentryValidateToken(args: {
  token: string;
  organization: string;
}): Promise<SentryConnection> {
  const slug = encodeURIComponent(args.organization);
  const organization = organizationSchema.parse(
    await sentryGet(args.token, `/organizations/${slug}/`),
  );
  return { organization };
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
