import { HttpError } from "@alfred/contracts";
import { z } from "zod";

import { authedJson } from "../shared/authed-json";
import { getActiveBearerCredential } from "../shared/credentials";
import type { ProviderBindOptions } from "../shared/provider";
import { restPassthroughCapability, type RestPassthroughProfile } from "../shared/rest-passthrough";
import type { RetryPolicy } from "../shared/retry";

/**
 * Sentry REST client (https://docs.sentry.io/api/). The user pastes an internal-integration
 * token, which never expires. That token gets 404 on
 * `/organizations/{slug}/sentry-app-installations/` (no memberships; checked 2026-09-06),
 * so webhooks are matched by signature, not installation.
 */

export const SENTRY_API = "https://sentry.io/api/0";

/** Only 401 and 403 mean a bad token; a 5xx or timeout is not the user's fault. */
export function isSentryAuthorizationError(err: unknown): boolean {
  return err instanceof HttpError && (err.status === 401 || err.status === 403);
}

function sentryHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

/** `/api/0` is in the base URL, so paths start at `/organizations/...`. */
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

/** `GET /organizations/` (no slug) works only for a user token, so read the one org. */
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

export interface SentryAuthResolver {
  (): Promise<{ token: string }>;
}

export interface SentryClientOptions {
  resolveAuth: SentryAuthResolver;
  retry: RetryPolicy | "none";
}

/** Passthrough only. Curated reads arrive with the consumer that needs them. */
export function createSentryClient(options: SentryClientOptions) {
  const passthrough = restPassthroughCapability({
    slug: "sentry",
    retry: options.retry,
    resolveProfile: async () => sentryPassthroughProfile((await options.resolveAuth()).token),
  });

  return {
    /** Read-only passthrough profile (ADR-0074). The read gate lives in `@alfred/assistant`. */
    passthrough,
  };
}

export type SentryClient = ReturnType<typeof createSentryClient>;

export function sentryClientForUser(options: ProviderBindOptions): SentryClient {
  const { userId, retry } = options;

  const resolveAuth = async () => {
    const cred = await getActiveBearerCredential(userId, "sentry", options.accountRef);

    return { token: cred.accessToken };
  };

  return createSentryClient({ resolveAuth, retry });
}
