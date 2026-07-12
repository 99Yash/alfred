/**
 * One home for "resolve the active Google credential that grants the scope
 * this tool needs."
 *
 * A user can connect several Google accounts, and any one credential may grant
 * only a subset of features (Gmail-only, Calendar-only, ...). "First active"
 * therefore risks a silent 403 (valid token, insufficient scope) that collapses
 * to the opaque `tool_execution_failed`. Every Google tool used to hand-roll
 * this pick with a slightly different policy — gmail/calendar/drive enforced a
 * scope, docs/sheets/slides didn't (and 403'd for a Gmail-only account). This
 * module is the single door they all go through: declare a scope policy, get a
 * scope-satisfying credential (or a typed, actionable error).
 *
 * Single-account is the norm for Alfred, so we don't disambiguate across
 * multiple scope-satisfying accounts here (no tool threads an explicit
 * accountId yet — a future refinement); the first match wins.
 *
 * A dead refresh token self-heals into an actionable error too:
 * `getFreshAccessToken` flips that credential to `needs_reauth`, so the next
 * call finds no active scope-satisfying credential and raises the policy's
 * connection/scope error instead of a generic failure.
 */

import { getFreshAccessToken, listCredentials } from "@alfred/integrations/google";
import { AppError, type AppErrorCode } from "../../lib/app-errors";

/** A credential row as returned by `listCredentials` (id, scopes, status, ...). */
type GoogleCredential = Awaited<ReturnType<typeof listCredentials>>[number];

/** True when the credential grants at least one of `scopes` (any-of). */
function grantsAnyScope(cred: GoogleCredential, scopes: readonly string[]): boolean {
  return scopes.some((s) => cred.scopes.includes(s));
}

export interface GoogleScopePolicy {
  /**
   * OAuth scopes that satisfy the tool, matched any-of. Omit (or pass empty)
   * to accept any active Google credential — only for tools whose scope is
   * implied and a stray wrong-account pick is harmless.
   */
  scopes?: readonly string[];
  /** Raised when no Google account is connected (no active credential at all). */
  noConnection: AppErrorCode;
  /**
   * Raised when a Google account is connected but none grants a required scope.
   * Falls back to `noConnection` when omitted (e.g. scopeless policies).
   */
  noScope?: AppErrorCode;
}

/**
 * Active Google credentials granting at least one of `scopes` (any-of), or all
 * active credentials when `scopes` is omitted. Used by tools that legitimately
 * fan out across every scope-satisfying account (Calendar reads).
 */
export async function activeGoogleCredentials(
  userId: string,
  scopes?: readonly string[],
): Promise<GoogleCredential[]> {
  const active = (await listCredentials(userId, "google")).filter((c) => c.status === "active");
  if (!scopes || scopes.length === 0) return active;
  return active.filter((c) => grantsAnyScope(c, scopes));
}

/**
 * Resolve the single active credential to run a tool call through, enforcing
 * the tool's scope policy. Throws `policy.noConnection` when nothing is
 * connected and `policy.noScope` (or `noConnection`) when a connected account
 * lacks the scope.
 */
export async function resolveGoogleCredential(
  userId: string,
  policy: GoogleScopePolicy,
): Promise<GoogleCredential> {
  const active = await activeGoogleCredentials(userId);
  if (active.length === 0) throw new AppError(policy.noConnection);
  const scoped =
    !policy.scopes || policy.scopes.length === 0
      ? active[0]
      : active.find((c) => grantsAnyScope(c, policy.scopes!));
  if (!scoped) throw new AppError(policy.noScope ?? policy.noConnection);
  return scoped;
}

/** Resolve a scope-satisfying credential and mint a fresh access token in one step. */
export async function resolveGoogleAccessToken(
  userId: string,
  policy: GoogleScopePolicy,
): Promise<string> {
  const credential = await resolveGoogleCredential(userId, policy);
  return getFreshAccessToken(credential.id);
}
