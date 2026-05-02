import { serverEnv } from "@alfred/env/server";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
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
 * Identity scopes always requested — they key our credential rows
 * (`sub` from `openid`, `email` from `userinfo.email`) and don't carry
 * Gmail data access.
 */
const IDENTITY_SCOPES = ["openid", "https://www.googleapis.com/auth/userinfo.email"] as const;

/**
 * Per-feature Gmail scopes. A feature's full required set is the
 * identity scopes plus its entry here.
 *
 *   briefing     — gmail.readonly: read user's mail to compose digests
 *   triage       — gmail.modify: write Alfred/<Cat> labels onto messages
 *   reply_draft  — gmail.send: outbound mail when alfred drafts on behalf
 *
 * Triage's `gmail.modify` already implies read access, but listing
 * `gmail.readonly` separately keeps each feature's scope row honest:
 * Google's consent screen will dedupe overlapping scopes for the user.
 */
export const GOOGLE_FEATURE_SCOPES = {
  briefing: ["https://www.googleapis.com/auth/gmail.readonly"],
  triage: [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.modify",
  ],
  reply_draft: ["https://www.googleapis.com/auth/gmail.send"],
} as const satisfies Record<string, readonly string[]>;

export type GoogleFeature = keyof typeof GOOGLE_FEATURE_SCOPES;

const ALL_FEATURES = Object.keys(GOOGLE_FEATURE_SCOPES) as GoogleFeature[];

/**
 * Resolve the OAuth scope list for a set of features. Always includes
 * identity scopes; deduplicates the union across requested features.
 *
 * Default (no `features` arg) returns the union of every feature —
 * matches the single-consent-prompt behavior we shipped at m7.
 * `include_granted_scopes=true` on the authorize URL means an
 * incremental re-prompt later just merges into the same grant.
 */
export function scopesForFeatures(features?: readonly GoogleFeature[]): string[] {
  const wanted = features?.length ? features : ALL_FEATURES;
  const set = new Set<string>(IDENTITY_SCOPES);
  for (const f of wanted) {
    for (const scope of GOOGLE_FEATURE_SCOPES[f]) set.add(scope);
  }
  return [...set];
}

/**
 * Default scopes when initiating a Google connection. Equivalent to
 * `scopesForFeatures()` (= union of every feature) — kept as a const
 * for readability at call sites that mean "give me the full grant."
 */
export const DEFAULT_GOOGLE_SCOPES: string[] = scopesForFeatures();

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
  const claims = await verifyIdToken(parsed.id_token, cfg.clientId);
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
 * Verify a Google id_token's signature, issuer, audience, and expiry
 * before trusting `sub`/`email` — these values key our credential rows,
 * so accepting unverified claims would let a forged token bind a
 * different identity. The TLS channel proves the token came from Google's
 * token endpoint *this* request, but the inner JWT must still be checked
 * because nothing else in this codebase reads `iss`/`aud`/`exp`.
 *
 * The JWKS is cached internally by `createRemoteJWKSet` and rotated on
 * unknown-kid lookups, so the cost is one fetch per pod per ~hours.
 */
const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const GOOGLE_ID_TOKEN_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

interface GoogleIdTokenClaims extends JWTPayload {
  sub?: string;
  email?: string;
  email_verified?: boolean;
}

async function verifyIdToken(
  idToken: string | undefined,
  audience: string,
): Promise<{ sub: string; email: string }> {
  if (!idToken) {
    throw new Error("[google.oauth] id_token missing — request 'openid email' scopes");
  }
  let claims: GoogleIdTokenClaims;
  try {
    const { payload } = await jwtVerify<GoogleIdTokenClaims>(idToken, GOOGLE_JWKS, {
      issuer: GOOGLE_ID_TOKEN_ISSUERS,
      audience,
    });
    claims = payload;
  } catch (err) {
    throw new Error(
      `[google.oauth] id_token verification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!claims.sub || !claims.email) {
    throw new Error("[google.oauth] id_token missing sub or email claims");
  }
  if (claims.email_verified === false) {
    throw new Error("[google.oauth] id_token email is not verified");
  }
  return { sub: claims.sub, email: claims.email };
}
