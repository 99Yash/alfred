/**
 * One home for "resolve the active Google credential that grants the scope
 * this tool needs."
 *
 * A user can connect several Google accounts, and any one credential may grant
 * only a subset of features (Gmail-only, Calendar-only, ...). "First active"
 * therefore risks a silent 403 (valid token, insufficient scope) that collapses
 * to the opaque `tool_execution_failed`. Every Google tool used to hand-roll
 * this pick with a slightly different policy — gmail/calendar enforced a scope,
 * while drive/docs/sheets/slides fell back to first-active (and 403'd for a
 * Gmail-only account). This module is the single door they all go through:
 * declare a scope policy, get a scope-satisfying credential (or a typed,
 * actionable error). `GoogleScopePolicy.scopes` is REQUIRED, so "every Google
 * tool must declare its scope" is a compile error to forget, not a convention.
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

import {
  getFreshAccessToken,
  listCredentials,
  type CredentialRow,
} from "@alfred/integrations/google";
import { AppError, type AppErrorCode } from "../../lib/app-errors";

/** True when the credential grants at least one of `scopes` (any-of). */
function grantsAnyScope(cred: CredentialRow, scopes: readonly string[]): boolean {
  return scopes.some((s) => cred.scopes.includes(s));
}

export interface GoogleScopePolicy {
  /**
   * OAuth scopes that satisfy the tool, matched any-of. REQUIRED: a scopeless
   * resolve would fall back to "first active credential" — the multi-account
   * mis-routing bug this module exists to eliminate — so every Google tool must
   * name the scope its call needs, enforced at the type level.
   */
  scopes: readonly string[];
  /** Raised when no Google account is connected (no active credential at all). */
  noConnection: AppErrorCode;
  /**
   * Raised when a Google account is connected but none grants a required scope.
   * Falls back to `noConnection` when omitted (e.g. Calendar write, whose
   * connection and scope errors are the same message).
   */
  noScope?: AppErrorCode;
}

/**
 * Active Google credentials granting at least one of `scopes` (any-of), or all
 * active credentials when `scopes` is omitted. Used by tools that legitimately
 * fan out across every scope-satisfying account (Calendar reads); the singular
 * resolver calls it scopeless internally, then filters by the policy's scope.
 */
export async function activeGoogleCredentials(
  userId: string,
  scopes?: readonly string[],
): Promise<CredentialRow[]> {
  const active = (await listCredentials(userId, "google")).filter((c) => c.status === "active");
  if (!scopes || scopes.length === 0) return active;
  return active.filter((c) => grantsAnyScope(c, scopes));
}

/**
 * Resolve the single active credential to run a tool call through, enforcing
 * the tool's scope policy. Throws `policy.noConnection` when nothing is
 * connected and `policy.noScope` (or `noConnection`) when a connected account
 * lacks the scope. The first scope-satisfying account wins (see module header).
 */
export async function resolveGoogleCredential(
  userId: string,
  policy: GoogleScopePolicy,
): Promise<CredentialRow> {
  const active = await activeGoogleCredentials(userId);
  if (active.length === 0) throw new AppError(policy.noConnection);
  const scoped = active.find((c) => grantsAnyScope(c, policy.scopes));
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
