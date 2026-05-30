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
 * Per-feature Google scopes. A feature's full required set is the
 * identity scopes plus its entry here.
 *
 *   briefing     — gmail.readonly: read user's mail to compose digests
 *   triage       — gmail.modify: write Alfred/<Cat> labels onto messages
 *   reply_draft  — gmail.send: outbound mail when alfred drafts on behalf
 *   calendar     — calendar.readonly: list events for meeting context
 *   drive        — drive.readonly: find/list files across the user's Drive
 *   docs         — documents.readonly: read structured Doc content (headings, tables)
 *   sheets       — spreadsheets.readonly: read cell ranges + sheet metadata
 *   slides       — presentations.readonly: read deck structure + speaker notes
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
 * than re-prompting for Gmail.
 *
 * Note on the Workspace scopes: `drive.readonly` is enough to *list and
 * download* files; structured API access to Docs/Sheets/Slides still
 * needs each app's own scope. We grant all four together so the same
 * consent screen unlocks both "find the deck" (drive) and "read what's
 * in the deck" (slides) without a second prompt.
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
export const DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
export const DOCS_READONLY_SCOPE = "https://www.googleapis.com/auth/documents.readonly";
export const SHEETS_READONLY_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
export const SLIDES_READONLY_SCOPE = "https://www.googleapis.com/auth/presentations.readonly";

export const GOOGLE_FEATURE_SCOPES = {
  briefing: [GMAIL_READONLY_SCOPE],
  triage: [GMAIL_READONLY_SCOPE, GMAIL_MODIFY_SCOPE],
  reply_draft: [GMAIL_SEND_SCOPE],
  calendar: [CALENDAR_READONLY_SCOPE],
  drive: [DRIVE_READONLY_SCOPE],
  docs: [DOCS_READONLY_SCOPE],
  sheets: [SHEETS_READONLY_SCOPE],
  slides: [SLIDES_READONLY_SCOPE],
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
 * Google's OAuth verification tiers. Only the *restricted* tier triggers
 * the recurring paid CASA security assessment when going public; the
 * sensitive tier (gmail.send, calendar.readonly, the Workspace reads)
 * verifies for free. We classify by scope rather than by feature because
 * the tier is Google's, not ours — a feature is restricted iff it pulls
 * in any restricted scope.
 *
 * Keeping this list explicit (vs. inferring from URL substrings) means a
 * new scope is non-restricted only by deliberate omission, and the
 * guardrail below fails loudly if a restricted scope lands in a feature
 * we expose to the public consent flow.
 */
export const RESTRICTED_SCOPES = new Set<string>([
  GMAIL_READONLY_SCOPE, // read message bodies
  GMAIL_MODIFY_SCOPE, // write labels / save drafts
  DRIVE_READONLY_SCOPE, // list + download Drive files
]);

/** A feature is restricted iff any of its scopes is in the restricted tier. */
export function isRestrictedFeature(f: GoogleFeature): boolean {
  return GOOGLE_FEATURE_SCOPES[f].some((s) => RESTRICTED_SCOPES.has(s));
}

/**
 * Features safe to request from the *public* consent flow: identity plus
 * sensitive scopes that verify for free (calendar, Workspace reads,
 * gmail.send). Once the free sensitive-scope review is done these serve
 * unlimited users with no "unverified app" warning and no user cap.
 */
export const PUBLIC_FEATURES: GoogleFeature[] = ALL_FEATURES.filter((f) => !isRestrictedFeature(f));

/**
 * Restricted Gmail/Drive features — opt-in only. Requesting these puts the
 * consent behind Google's unverified-app warning and the 100-user lifetime
 * cap until (and unless) the app passes the paid CASA assessment.
 */
export const RESTRICTED_FEATURES: GoogleFeature[] = ALL_FEATURES.filter(isRestrictedFeature);

/**
 * Default grant for a PUBLIC Google connection: free-to-verify scopes only.
 * This is what the connect endpoint and the `buildAuthorizeUrl` fallback use
 * so nothing requests a restricted scope by accident — restricted scopes are
 * only ever added when a caller explicitly opts in via a restricted feature.
 */
export const PUBLIC_GOOGLE_SCOPES: string[] = scopesForFeatures(PUBLIC_FEATURES);

/**
 * Full grant including restricted Gmail/Drive scopes. For the owner/beta
 * opt-in flow only — see {@link RESTRICTED_FEATURES} for the consequences.
 */
export const ALL_GOOGLE_SCOPES: string[] = scopesForFeatures();

/**
 * @deprecated Ambiguous name retained for back-compat — now aliases the
 * public (restricted-free) set, NOT the full union. Use
 * {@link PUBLIC_GOOGLE_SCOPES} or {@link ALL_GOOGLE_SCOPES} explicitly.
 */
export const DEFAULT_GOOGLE_SCOPES: string[] = PUBLIC_GOOGLE_SCOPES;

// Guardrail: a restricted scope must never reach the public consent flow.
// Fails at module load (caught by typecheck/tests/boot) if a future scope
// addition silently widens the public grant.
for (const f of PUBLIC_FEATURES) {
  if (isRestrictedFeature(f)) {
    throw new Error(
      `[google.oauth] feature "${f}" is in PUBLIC_FEATURES but requests a restricted scope`,
    );
  }
}

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
