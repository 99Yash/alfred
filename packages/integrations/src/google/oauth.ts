import type { AccountPersona } from "@alfred/contracts";
import { serverEnv } from "@alfred/env/server";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { z } from "zod";

export type { AccountPersona } from "@alfred/contracts";

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
const GOOGLE_OAUTH_FETCH_TIMEOUT_MS = 30_000;

/**
 * Identity scopes always requested — they key our credential rows
 * (`sub` from `openid`, `email` from `userinfo.email`) and don't carry
 * Gmail data access.
 */
const IDENTITY_SCOPES = ["openid", "https://www.googleapis.com/auth/userinfo.email"] as const;

/**
 * Per-feature Google scopes. A feature's full required set is the
 * identity scopes plus its entry here.
 *
 *   briefing     — gmail.readonly + calendar.readonly: open-loop orientation with calendar anchoring
 *   triage       — gmail.modify: write Alfred/<Cat> labels onto messages
 *   reply_draft  — gmail.send: outbound mail when alfred drafts on behalf
 *   calendar     — calendar.events: read events and create/update events
 *   drive        — drive: full read/write across the user's Drive
 *   docs         — documents: read + write structured Doc content (headings, tables)
 *   sheets       — spreadsheets: read + write cell ranges, create spreadsheets
 *   slides       — presentations: read + write decks, create presentations
 *
 * Triage's `gmail.modify` already implies read access, but listing
 * `gmail.readonly` separately keeps each feature's scope row honest:
 * Google's consent screen will dedupe overlapping scopes for the user.
 *
 * The Calendar and Workspace (Drive/Docs/Sheets/Slides) features live
 * alongside Gmail features because a user connects "Google" once and we
 * layer capability grants on top via `include_granted_scopes=true`.
 * Asking for `?features=docs` from the connect endpoint requests only
 * identity + docs, and Google merges it into the existing grant rather
 * than re-prompting for Gmail. The onboarding connect (no `?features`)
 * requests every feature in one consent — Alfred operates as a single
 * Production-unverified tenant (ADR-0044, amended 2026-06-08), so there is
 * no verification surface to minimize and no scope tier to dodge: the one
 * owner clicks through the unverified-app warning once and grants the lot.
 *
 * The scopes are full read/write across Gmail (`gmail.modify` + `gmail.send`),
 * Calendar (`calendar.events`), Drive (`drive`), and the Workspace editors
 * (`documents` / `spreadsheets` / `presentations`). Full `drive` already
 * covers list/download/upload of any file; the per-app editor scopes add
 * structured read/write of Docs/Sheets/Slides content. The full mailbox
 * scope (`https://mail.google.com/`, IMAP + permanent delete) is the one
 * deliberate omission — no tool needs it and it maximizes breach radius.
 *
 * Individual scope URLs are named below so callers can reference a
 * capability by intent (`GMAIL_MODIFY_SCOPE`) instead of by position in
 * a feature tuple — reordering a tuple then can't silently repoint a
 * scope check at the wrong grant.
 */
export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const CALENDAR_READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
export const CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
/** Full read/write Drive — list/download/upload + manage any file. */
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
/** Full read/write Docs — read + edit structured Doc content. */
export const DOCS_SCOPE = "https://www.googleapis.com/auth/documents";
/** Full read/write Sheets — create + edit spreadsheets. */
export const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
/** Full read/write Slides — create + edit presentations. */
export const SLIDES_SCOPE = "https://www.googleapis.com/auth/presentations";

export const GOOGLE_FEATURE_SCOPES = {
  briefing: [GMAIL_READONLY_SCOPE, CALENDAR_READONLY_SCOPE],
  triage: [GMAIL_READONLY_SCOPE, GMAIL_MODIFY_SCOPE],
  reply_draft: [GMAIL_SEND_SCOPE],
  calendar: [CALENDAR_EVENTS_SCOPE],
  drive: [DRIVE_SCOPE],
  docs: [DOCS_SCOPE],
  sheets: [SHEETS_SCOPE],
  slides: [SLIDES_SCOPE],
} as const satisfies Record<string, readonly string[]>;

export type GoogleFeature = keyof typeof GOOGLE_FEATURE_SCOPES;

const ALL_FEATURES = Object.keys(GOOGLE_FEATURE_SCOPES) as GoogleFeature[];

/**
 * Resolve the OAuth scope list for a set of features. Always includes
 * identity scopes; deduplicates the union across requested features.
 *
 * `undefined` (no arg) returns the union of every feature — the default
 * grant the onboarding connect uses. An explicit empty array returns
 * identity scopes ONLY; it does NOT fall back to the full union, so a
 * malformed `?features=,` parsing to `[]` requests nothing beyond identity
 * rather than silently widening the grant. `include_granted_scopes=true` on
 * the authorize URL means an incremental re-prompt later just merges into
 * the same grant.
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
 * The full Google grant: identity + every feature's scopes. This is what a
 * Google connection requests — the onboarding connect, the `buildAuthorizeUrl`
 * fallback, and the smoke script all resolve to this set.
 *
 * Alfred runs as a single Production-unverified tenant (ADR-0044, amended
 * 2026-06-08), so there is no public-app verification surface to minimize and
 * no scope-tier line to police. The earlier PUBLIC/RESTRICTED split existed
 * only to keep a someday-public app off Google's paid CASA review; that goal
 * was retired, so the split went with it. Scopes are still selectable
 * per-feature via `scopesForFeatures(features)` for targeted reconnects, and
 * `requireScopes()` still gates each tool on its feature's scopes.
 */
export const ALL_GOOGLE_SCOPES: string[] = scopesForFeatures();

/** The grant `buildAuthorizeUrl` uses when a caller passes no explicit scopes. */
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
  /**
   * Decoded `hd` (hosted-domain) claim from the id_token, present only for
   * Google Workspace accounts. Drives account-persona detection (ADR-0051 #3):
   * present → `work`, absent → `personal`.
   */
  hostedDomain?: string;
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
    signal: AbortSignal.timeout(GOOGLE_OAUTH_FETCH_TIMEOUT_MS),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`[google.oauth] token exchange failed: ${res.status} ${JSON.stringify(json)}`);
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
    ...(claims.hostedDomain ? { hostedDomain: claims.hostedDomain } : {}),
    expiresAt: new Date(Date.now() + parsed.expires_in * 1000),
    scopes: parsed.scope ? parsed.scope.split(/\s+/).filter(Boolean) : [],
  };
}

/**
 * Detect account persona from the Google `hd` (hosted-domain) claim: a
 * Workspace domain means a work account, its absence means personal. The
 * rich persona *policy* is deferred (own ADR); this is just the label.
 */
export function detectPersona(hostedDomain: string | undefined): AccountPersona {
  return hostedDomain ? "work" : "personal";
}

export interface RefreshTokenResult {
  accessToken: string;
  expiresAt: Date;
  /** Some refresh responses include a fresh refresh_token; most don't. */
  refreshToken?: string;
  scopes: string[];
}

/**
 * Thrown when Google rejects a refresh with `invalid_grant` — the refresh
 * token is dead (revoked, consent withdrawn, or expired under the Testing-mode
 * 7-day window). Retrying never recovers it; the only fix is user re-consent.
 * Callers catch this to flip the credential to `needs_reauth` instead of
 * looping the same failure every poll.
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
    signal: AbortSignal.timeout(GOOGLE_OAUTH_FETCH_TIMEOUT_MS),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    if (
      json &&
      typeof json === "object" &&
      (json as { error?: unknown }).error === "invalid_grant"
    ) {
      throw new GoogleReauthRequiredError(JSON.stringify(json));
    }
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
  /** Workspace hosted domain — present only for Workspace accounts. */
  hd?: string;
}

async function verifyIdToken(
  idToken: string | undefined,
  audience: string,
): Promise<{ sub: string; email: string; hostedDomain?: string }> {
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
  const hostedDomain =
    typeof claims.hd === "string" && claims.hd.trim() ? claims.hd.trim() : undefined;
  return { sub: claims.sub, email: claims.email, ...(hostedDomain ? { hostedDomain } : {}) };
}
