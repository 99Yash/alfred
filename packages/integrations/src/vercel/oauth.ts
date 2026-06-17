import { serverEnv } from "@alfred/env/server";

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
  const env = serverEnv();
  return Boolean(
    env.VERCEL_CLIENT_ID && env.VERCEL_CLIENT_SECRET && env.VERCEL_REDIRECT_URI && env.VERCEL_APP_SLUG,
  );
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
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`[vercel.oauth] token exchange ${res.status} :: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    access_token: string;
    token_type?: string;
    installation_id?: string | null;
    user_id?: string | null;
    team_id?: string | null;
  };
  return {
    accessToken: json.access_token,
    tokenType: json.token_type ?? "Bearer",
    installationId: json.installation_id ?? null,
    userId: json.user_id ?? null,
    teamId: json.team_id ?? null,
  };
}
