import { serverEnv } from "@alfred/env/server";
import { z } from "zod";

/**
 * OAuth 2.0 authorization-code helpers for Google. We avoid the
 * `googleapis` and `google-auth-library` packages — both are large and
 * carry transitive deps we don't need. Two HTTP calls (authorize URL +
 * token exchange) and one for refresh; this module is the entire flow.
 *
 * Per ADR-0009 implementation note: integration tokens live in their own
 * `integration_credentials` table, distinct from Better Auth's `account`.
 */

const AUTH_BASE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_BASE = "https://oauth2.googleapis.com/token";

/**
 * Default scopes when initiating a Google connection. Single consent
 * covers the read+send+modify operations m7→m9 will need so we don't
 * re-prompt later.
 *
 *   gmail.readonly  — pull message bodies + headers (m7a)
 *   gmail.send      — outbound mail for reply drafts + briefings (m7c, m9)
 *   gmail.modify    — write Gmail labels for triage (m9)
 *   userinfo.email  — read the user's email (account_id surface)
 *   openid          — id_token issuance, gives us `sub` deterministically
 */
export const DEFAULT_GOOGLE_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
];

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Read OAuth config from env. Throws when not configured — caller decides if that's fatal. */
export function getGoogleOAuthConfig(): GoogleOAuthConfig {
  const env = serverEnv();
  const { GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URI } = env;
  if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET || !GOOGLE_OAUTH_REDIRECT_URI) {
    throw new Error(
      "Google OAuth not configured. Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and GOOGLE_OAUTH_REDIRECT_URI in apps/server/.env",
    );
  }
  return {
    clientId: GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri: GOOGLE_OAUTH_REDIRECT_URI,
  };
}

export interface BuildAuthorizeUrlArgs {
  state: string;
  scopes?: string[];
  /**
   * `prompt=consent` forces Google to re-issue a refresh token even if
   * the user has consented before. We need the refresh token on every
   * connect — without it, tokens silently expire after an hour and the
   * background workers grind to a halt.
   */
  forceConsent?: boolean;
  /** `login_hint` shortcuts the account picker when we know the email. */
  loginHint?: string;
}

export function buildAuthorizeUrl(args: BuildAuthorizeUrlArgs): string {
  const cfg = getGoogleOAuthConfig();
  const scopes = args.scopes ?? DEFAULT_GOOGLE_SCOPES;
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    state: args.state,
    include_granted_scopes: "true",
  });
  if (args.forceConsent !== false) params.set("prompt", "consent");
  if (args.loginHint) params.set("login_hint", args.loginHint);
  return `${AUTH_BASE}?${params.toString()}`;
}

/** Shape of a successful response from Google's token endpoint. */
const tokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number().int(),
  token_type: z.string(),
  scope: z.string().optional(),
  refresh_token: z.string().optional(),
  id_token: z.string().optional(),
});
export type GoogleTokenResponse = z.infer<typeof tokenResponseSchema>;

export interface ExchangeCodeResult extends GoogleTokenResponse {
  /** Decoded `sub` from the id_token — provider-side stable user id. */
  accountId: string;
  /** Decoded `email` from the id_token — surfaced to UI as the account label. */
  accountEmail: string;
  /** Computed expiry timestamp. */
  expiresAt: Date;
  /** Granted scopes parsed into an array. Empty when Google doesn't echo `scope` (rare). */
  scopes: string[];
}

export async function exchangeCode(code: string): Promise<ExchangeCodeResult> {
  const cfg = getGoogleOAuthConfig();
  const body = new URLSearchParams({
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetch(TOKEN_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      `[google.oauth] token exchange failed: ${res.status} ${JSON.stringify(json)}`,
    );
  }
  const parsed = tokenResponseSchema.parse(json);
  if (!parsed.refresh_token) {
    // Forcing consent above should make this near-impossible; treat as
    // hard error so we don't silently accept short-lived credentials.
    throw new Error("[google.oauth] no refresh_token returned; re-run with prompt=consent");
  }
  const claims = decodeIdTokenClaims(parsed.id_token);
  return {
    ...parsed,
    accountId: claims.sub,
    accountEmail: claims.email,
    expiresAt: new Date(Date.now() + parsed.expires_in * 1000),
    scopes: parsed.scope ? parsed.scope.split(/\s+/).filter(Boolean) : [],
  };
}

export interface RefreshTokenResult {
  accessToken: string;
  expiresAt: Date;
  /** Some refresh responses include a fresh refresh_token; most don't. */
  refreshToken?: string;
  scopes: string[];
}

export async function refreshAccessToken(refreshToken: string): Promise<RefreshTokenResult> {
  const cfg = getGoogleOAuthConfig();
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`[google.oauth] refresh failed: ${res.status} ${JSON.stringify(json)}`);
  }
  const parsed = tokenResponseSchema.parse(json);
  return {
    accessToken: parsed.access_token,
    expiresAt: new Date(Date.now() + parsed.expires_in * 1000),
    refreshToken: parsed.refresh_token,
    scopes: parsed.scope ? parsed.scope.split(/\s+/).filter(Boolean) : [],
  };
}

/**
 * Decode the `sub` and `email` claims from a Google id_token. We trust
 * the claims because they're delivered over TLS straight from Google's
 * token endpoint — no need to verify the JWT signature here. (If we
 * ever accept id_tokens received via redirect, we'd have to verify.)
 */
function decodeIdTokenClaims(idToken: string | undefined): { sub: string; email: string } {
  if (!idToken) {
    throw new Error("[google.oauth] id_token missing — request 'openid email' scopes");
  }
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("[google.oauth] malformed id_token");
  const payload = parts[1];
  if (!payload) throw new Error("[google.oauth] empty id_token payload");
  const decoded = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString();
  const claims = JSON.parse(decoded) as { sub?: string; email?: string };
  if (!claims.sub || !claims.email) {
    throw new Error("[google.oauth] id_token missing sub or email claims");
  }
  return { sub: claims.sub, email: claims.email };
}
