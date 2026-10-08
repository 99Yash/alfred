import {
  GOOGLE_FEATURE_SCOPES,
  isRecord,
  parseOAuthScopeList,
  toMessage,
  type AccountPersona,
  type GoogleFeature,
} from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { INTEGRATION_FETCH_TIMEOUT_MS } from "../shared/authed-fetch";

export type { AccountPersona } from "@alfred/contracts";

/**
 * Google OAuth code flow without `googleapis`: authorize URL, code exchange, refresh.
 * Tokens live in `integration_credentials`, not Better Auth's `account` (ADR-0009).
 */

const AUTH_BASE = "https://accounts.google.com/o/oauth2/v2/auth";

const TOKEN_BASE = "https://oauth2.googleapis.com/token";

/** Always requested: `sub` and `email` key the credential rows. */
const IDENTITY_SCOPES = ["openid", "https://www.googleapis.com/auth/userinfo.email"] as const;

const ALL_FEATURES =
  // SAFETY: GoogleFeature is `keyof typeof GOOGLE_FEATURE_SCOPES`.
  Object.keys(GOOGLE_FEATURE_SCOPES) as GoogleFeature[];

/**
 * Identity scopes plus the scopes of each feature. `undefined` means every feature.
 * An empty array means identity only, so a malformed `?features=,` does not widen the grant.
 */
export function scopesForFeatures(features?: readonly GoogleFeature[]): string[] {
  const wanted = features ?? ALL_FEATURES;
  const set = new Set<string>(IDENTITY_SCOPES);

  for (const f of wanted) {
    for (const scope of GOOGLE_FEATURE_SCOPES[f]) set.add(scope);
  }

  return [...set];
}

/**
 * Identity plus every feature. Alfred is a single unverified Production tenant, so
 * it asks for the full grant in one consent (ADR-0044, amended).
 */
export const ALL_GOOGLE_SCOPES: string[] = scopesForFeatures();

export const DEFAULT_GOOGLE_SCOPES: string[] = ALL_GOOGLE_SCOPES;

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function getGoogleOAuthConfig(): GoogleOAuthConfig {
  const { GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URI } =
    serverEnv();

  return {
    clientId: GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri: GOOGLE_OAUTH_REDIRECT_URI,
  };
}

export interface BuildAuthorizeUrlArgs {
  state: string;
  scopes?: string[] | undefined;
  /** `prompt=consent` makes Google issue a refresh token even after a past consent. */
  forceConsent?: boolean | undefined;
  /** Skips the account picker. */
  loginHint?: string | undefined;
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

const tokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number().int(),
  token_type: z.string(),
  scope: z.string().optional(),
  refresh_token: z.string().optional(),
  id_token: z.string().optional(),
});

type GoogleTokenResponse = z.infer<typeof tokenResponseSchema>;

export interface ExchangeCodeResult extends GoogleTokenResponse {
  /** id_token `sub`: Google's stable user id. */
  accountId: string;
  accountEmail: string;
  /** id_token `hd`, only on Workspace accounts. Sets the persona (ADR-0051). */
  hostedDomain?: string | undefined;
  expiresAt: Date;
  /** Empty when Google does not echo `scope`. */
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
    signal: AbortSignal.timeout(INTEGRATION_FETCH_TIMEOUT_MS),
  });

  const json = await res.json().catch(() => null);

  if (!res.ok) {
    throw new Error(`[google.oauth] token exchange failed: ${res.status} ${JSON.stringify(json)}`);
  }

  const parsed = tokenResponseSchema.parse(json);

  if (!parsed.refresh_token) {
    // Do not accept a credential that dies in an hour.
    throw new Error("[google.oauth] no refresh_token returned; re-run with prompt=consent");
  }

  const claims = await verifyIdToken(parsed.id_token, cfg.clientId);

  return {
    ...parsed,
    accountId: claims.sub,
    accountEmail: claims.email,
    ...(claims.hostedDomain ? { hostedDomain: claims.hostedDomain } : {}),
    expiresAt: new Date(Date.now() + parsed.expires_in * 1000),
    scopes: parseOAuthScopeList(parsed.scope),
  };
}

/** A Workspace domain means work; none means personal. */
export function detectPersona(hostedDomain: string | undefined): AccountPersona {
  return hostedDomain ? "work" : "personal";
}

export interface RefreshTokenResult {
  accessToken: string;
  expiresAt: Date;
  /** Most refresh responses omit this. */
  refreshToken?: string | undefined;
  scopes: string[];
}

/**
 * `invalid_grant`: the refresh token is dead (revoked, password reset, or 6 months unused).
 * The app is In Production, so the Testing-mode 7-day expiry does not apply.
 * Only re-consent fixes it; callers mark the credential `needs_reauth`.
 */
export class GoogleReauthRequiredError extends Error {
  constructor(detail: string) {
    super(`[google.oauth] refresh token revoked or expired — re-consent required: ${detail}`);
    this.name = "GoogleReauthRequiredError";
  }
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
    signal: AbortSignal.timeout(INTEGRATION_FETCH_TIMEOUT_MS),
  });

  const json = await res.json().catch(() => null);

  if (!res.ok) {
    if (isRecord(json) && json.error === "invalid_grant") {
      throw new GoogleReauthRequiredError(JSON.stringify(json));
    }

    throw new Error(`[google.oauth] refresh failed: ${res.status} ${JSON.stringify(json)}`);
  }

  const parsed = tokenResponseSchema.parse(json);

  return {
    accessToken: parsed.access_token,
    expiresAt: new Date(Date.now() + parsed.expires_in * 1000),
    refreshToken: parsed.refresh_token,
    scopes: parseOAuthScopeList(parsed.scope),
  };
}

/**
 * Verify the id_token before trusting `sub` and `email`: they key the credential rows.
 * `createRemoteJWKSet` caches the keys and refetches on an unknown `kid`.
 */
const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

const GOOGLE_ID_TOKEN_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

/**
 * jose's `jwtVerify<T>` checks nothing at runtime, so parse the payload.
 * `sub` and `email` stay optional so their absence gets its own error below.
 */
const idTokenClaimsSchema = z.object({
  sub: z.string().optional(),
  email: z.string().optional(),
  email_verified: z.boolean().optional(),
  hd: z.string().optional(),
});

async function verifyIdToken(
  idToken: string | undefined,
  audience: string,
): Promise<{ sub: string; email: string; hostedDomain?: string }> {
  if (!idToken) {
    throw new Error("[google.oauth] id_token missing — request 'openid email' scopes");
  }

  let claims: z.infer<typeof idTokenClaimsSchema>;

  try {
    const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
      issuer: GOOGLE_ID_TOKEN_ISSUERS,
      audience,
    });

    claims = idTokenClaimsSchema.parse(payload);
  } catch (err) {
    throw new Error(`[google.oauth] id_token verification failed: ${toMessage(err)}`);
  }

  if (!claims.sub || !claims.email) {
    throw new Error("[google.oauth] id_token missing sub or email claims");
  }

  if (claims.email_verified === false) {
    throw new Error("[google.oauth] id_token email is not verified");
  }

  const hostedDomain = claims.hd?.trim() || undefined;

  return { sub: claims.sub, email: claims.email, ...(hostedDomain ? { hostedDomain } : {}) };
}
