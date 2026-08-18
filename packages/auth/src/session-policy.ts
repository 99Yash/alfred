import { db } from "@alfred/db";
import { session as sessionTable } from "@alfred/db/schema/auth";
import type { BetterAuthOptions } from "better-auth";
import { eq } from "drizzle-orm";

/**
 * The session lifetime both Better Auth instances run on (#454).
 *
 * Alfred has one account, and that account holds Gmail read+write, Drive,
 * Calendar, a GitHub App, and the Notion / Vercel / Railway bearer tokens. So
 * the only question worth asking about a session is how long a stolen cookie
 * stays useful. Before this module there was no `session` block at all, which
 * left three things implicit and one thing missing.
 *
 * The three implicit ones are restated below rather than changed. A library
 * default is not a decision, and a default that moves in a minor release moves
 * the security posture with it.
 *
 * The missing one is the absolute cap. Better Auth slides `expiresAt` forward
 * on every use (see {@link SESSION_SLIDE_SECONDS}), and it has no option that
 * bounds the total. A cookie in continuous use therefore renews itself for
 * ever. {@link SESSION_ABSOLUTE_MAX_SECONDS} is that bound, and
 * {@link isPastAbsoluteLifetime} is where it is applied.
 */

/**
 * How long a session survives with no use at all. Better Auth's own default,
 * restated.
 *
 * The real idle window is between this value and this value minus
 * {@link SESSION_SLIDE_SECONDS}, because the push forward only happens on the
 * slide step below.
 */
const SESSION_IDLE_SECONDS = 60 * 60 * 24 * 7;

/**
 * How often a use pushes the expiry forward. Better Auth's own default,
 * restated.
 *
 * This is a write throttle, not a limit: Better Auth rewrites `expires_at` to
 * "now + idle window" only when the row was last rewritten at least this long
 * ago. A smaller value means more writes and a more exact idle window.
 */
const SESSION_SLIDE_SECONDS = 60 * 60 * 24;

/**
 * How long after sign-in Better Auth still calls a session "fresh". Better
 * Auth's own default, restated.
 *
 * Freshness is measured from `session.created_at`, which no slide ever moves,
 * so a session cannot become fresh again — only a new sign-in is fresh. That is
 * why Alfred puts no freshness gate in front of its own write tools: the gate
 * could only ever be satisfied by signing in again, and the largest blast
 * radius (briefings, triage, every autonomous write) runs from the job queue
 * with no session at all, so the gate would miss it while adding friction to
 * chat. See `docs/reference/auth.md`.
 *
 * The value is not inert. Better Auth's own `/list-sessions` and `/update-user`
 * routes refuse a session older than this. `/revoke-sessions` and
 * `/revoke-other-sessions` do NOT, which is what lets the Settings control work
 * from a session of any age.
 */
const SESSION_FRESH_AGE_SECONDS = 60 * 60 * 24;

/**
 * The hard ceiling on one session, measured from sign-in.
 *
 * `session.created_at` is written once and no refresh path touches it — Better
 * Auth's slide updates `expires_at` and `updated_at` only — so it is a truthful
 * origin for an absolute age. Past this age the session is revoked on its next
 * read, and no amount of continued use extends it.
 */
const SESSION_ABSOLUTE_MAX_SECONDS = 60 * 60 * 24 * 30;

/**
 * The `session` block for a Better Auth instance. Both instances take the same
 * one: they read the same rows and answer on the same paths, so a lifetime that
 * held on only one of them would be a lifetime an attacker picks around.
 */
export function authSession(): NonNullable<BetterAuthOptions["session"]> {
  return {
    expiresIn: SESSION_IDLE_SECONDS,
    updateAge: SESSION_SLIDE_SECONDS,
    freshAge: SESSION_FRESH_AGE_SECONDS,
  };
}

/**
 * Whether `secure` cookies — and therefore the `__Secure-` cookie name prefix —
 * are on.
 *
 * Better Auth composes the session cookie name as
 * `${__Secure- if secure}${cookiePrefix}.session_token`, and it decides
 * `secure` from, in order: this option, the `baseURL` protocol, then
 * `NODE_ENV`. The two instances pass different `baseURL` values — `auth()`
 * passes none and `sessionAuth()` passes `BETTER_AUTH_URL` — so without this
 * option they can disagree about the cookie NAME, and then one of them cannot
 * find the other's cookie. Naming the source of truth once removes that.
 *
 * `__Host-` is stronger and is not reachable here. Better Auth never writes it:
 * its cookie reader looks for `__Secure-${name}` or the bare name and nothing
 * else, so a `__Host-` name forced through `advanced.cookies` would be a cookie
 * Better Auth itself could no longer read.
 */
export function authSecureCookies(nodeEnv: string): boolean {
  return nodeEnv === "production";
}

/**
 * Whether a session has outlived {@link SESSION_ABSOLUTE_MAX_SECONDS}.
 *
 * Fails CLOSED on a `created_at` that does not parse. The column is a NOT NULL
 * timestamp, so an unreadable value means a corrupt row rather than a new
 * session, and the cost of being wrong is one sign-in.
 */
export function isPastAbsoluteLifetime(
  createdAt: Date | string | number,
  nowMs: number = Date.now(),
): boolean {
  const createdMs = new Date(createdAt).getTime();
  if (!Number.isFinite(createdMs)) return true;
  return nowMs - createdMs >= SESSION_ABSOLUTE_MAX_SECONDS * 1000;
}

/**
 * Delete one session row by token.
 *
 * Deleting the row, rather than returning "no session" from one read path, is
 * what makes the cap hold everywhere: Better Auth's own mounted routes read the
 * same table and stop honouring the cookie the moment the row is gone.
 */
export async function revokeSessionByToken(token: string): Promise<void> {
  await db().delete(sessionTable).where(eq(sessionTable.token, token));
}

/** Read-only view of the numbers, for tests and for `docs/reference/auth.md`. */
export const SESSION_LIFETIME_SECONDS = {
  idle: SESSION_IDLE_SECONDS,
  slide: SESSION_SLIDE_SECONDS,
  fresh: SESSION_FRESH_AGE_SECONDS,
  absoluteMax: SESSION_ABSOLUTE_MAX_SECONDS,
} as const;
