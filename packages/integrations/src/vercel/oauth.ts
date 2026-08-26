import { serverEnv } from "@alfred/env/server";
import { z } from "zod";

import { INTEGRATION_FETCH_TIMEOUT_MS } from "../shared/authed-fetch";

/**
 * Vercel integration OAuth (https://vercel.com/docs/integrations/sign-in).
 * The "authorize" step is the integration install URL; Vercel redirects back
 * with a `code` we exchange for a non-expiring access token (no refresh
 * token). A team install also returns `team_id`, which every subsequent API
 * call must echo as `?teamId=`.
 */

const VERCEL_TOKEN_URL = "https://api.vercel.com/v2/oauth/access_token";

export interface VercelOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  appSlug: string;
}

export function getVercelOAuthConfig(): VercelOAuthConfig {
  const env = serverEnv();
  if (
    !env.VERCEL_CLIENT_ID ||
    !env.VERCEL_CLIENT_SECRET ||
    !env.VERCEL_REDIRECT_URI ||
    !env.VERCEL_APP_SLUG
  ) {
    throw new Error(
      "[vercel.oauth] Vercel is not configured — set VERCEL_CLIENT_ID, VERCEL_CLIENT_SECRET, VERCEL_REDIRECT_URI, VERCEL_APP_SLUG",
    );
  }
  return {
    clientId: env.VERCEL_CLIENT_ID,
    clientSecret: env.VERCEL_CLIENT_SECRET,
    redirectUri: env.VERCEL_REDIRECT_URI,
    appSlug: env.VERCEL_APP_SLUG,
  };
}

export function isVercelConfigured(): boolean {
  try {
    getVercelOAuthConfig();
    return true;
  } catch {
    return false;
  }
}

/** The integration install URL. Vercel appends `code`/`configurationId`/`teamId` on the callback. */
export function buildVercelInstallUrl(state: string): string {
  const cfg = getVercelOAuthConfig();
  const url = new URL(`https://vercel.com/integrations/${cfg.appSlug}/new`);
  url.searchParams.set("state", state);
  return url.toString();
}

export interface VercelTokenResult {
  accessToken: string;
  tokenType: string;
  installationId: string | null;
  userId: string | null;
  teamId: string | null;
}

/**
 * Vercel's token-exchange response. External payload, so it is validated at
 * this boundary instead of asserted — a malformed body fails the exchange
 * loudly rather than persisting `undefined` token fields.
 */
const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  installation_id: z.string().nullish(),
  user_id: z.string().nullish(),
  team_id: z.string().nullish(),
});

export async function exchangeVercelCode(code: string): Promise<VercelTokenResult> {
  const cfg = getVercelOAuthConfig();
  const form = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code,
    redirect_uri: cfg.redirectUri,
  });
  const res = await fetch(VERCEL_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    signal: AbortSignal.timeout(INTEGRATION_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`[vercel.oauth] token exchange ${res.status} :: ${body.slice(0, 300)}`);
  }
  const parsed = tokenResponseSchema.safeParse(await res.json());
  if (!parsed.success) {
    throw new Error("[vercel.oauth] token exchange returned an unexpected shape");
  }
  const json = parsed.data;
  return {
    accessToken: json.access_token,
    tokenType: json.token_type ?? "Bearer",
    installationId: json.installation_id ?? null,
    userId: json.user_id ?? null,
    teamId: json.team_id ?? null,
  };
}
