import type { BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";

type AuthDatabaseHooks = NonNullable<BetterAuthOptions["databaseHooks"]>;
type NonSessionDatabaseHooks = Omit<AuthDatabaseHooks, "session">;
type AuthRequestHooks = NonNullable<BetterAuthOptions["hooks"]>;
type NonBeforeAuthRequestHooks = Omit<AuthRequestHooks, "before">;
type AuthSessionPolicyInput = {
  databaseHooks?: NonSessionDatabaseHooks;
  hooks?: NonBeforeAuthRequestHooks;
};
type AuthSessionPolicy = {
  session: NonNullable<BetterAuthOptions["session"]>;
  databaseHooks: AuthDatabaseHooks;
  hooks: AuthRequestHooks;
};

/**
 * The session lifetime Alfred's Better Auth instance runs on (#454).
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
 * ever. {@link SESSION_ABSOLUTE_MAX_SECONDS} is that bound, and the session
 * update hook returned by {@link authSessionPolicy} applies it before every
 * sliding expiry reaches storage.
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
 * Better Auth uses this value for its own freshness checks. The verified route
 * behavior and the Settings consequence are in `docs/reference/auth.md`, which
 * is Alfred's local owner for that dependency detail.
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

function absoluteSessionDeadlineMs(createdMs: number): number {
  return createdMs + SESSION_ABSOLUTE_MAX_SECONDS * 1000;
}

const absoluteLifetimeGuard = createAuthMiddleware(async (context) => {
  const token = await context.getSignedCookie(
    context.context.authCookies.sessionToken.name,
    context.context.secret,
  );
  if (!token) return;

  // The update hook cannot repair a pre-policy row before its first read:
  // Better Auth accepts the old expiry, persists the clamp, then returns the
  // updated session without checking that the clamp is already in the past.
  // Retire such a row before any endpoint runs. The endpoint then performs its
  // normal session read and cannot authorize with the removed row.
  const current = await context.context.internalAdapter.findSession(token);
  if (!current) return;

  const deadlineMs = absoluteSessionDeadlineMs(current.session.createdAt.getTime());
  if (!Number.isFinite(deadlineMs) || Date.now() >= deadlineMs) {
    // Cleanup is best-effort for this request. Better Auth can swallow its
    // pre-delete snapshot failure and skip the delete, so request admission
    // must terminate independently of whether the row was removed.
    await context.context.internalAdapter.deleteSession(token);
    throw new APIError("UNAUTHORIZED");
  }

  if (current.session.expiresAt.getTime() > deadlineMs) {
    // A pre-policy row can still carry a sliding expiry beyond the new cap.
    // Normalize it before the endpoint's own session read so every downstream
    // caller, including a policy-neutral HTTP cache, receives the native
    // exclusive deadline instead of the legacy value.
    context.context.session = current;
    const normalized = await context.context.internalAdapter.updateSession(token, {
      expiresAt: new Date(deadlineMs),
    });
    if (!normalized || normalized.expiresAt.getTime() > deadlineMs) {
      throw new APIError("UNAUTHORIZED");
    }
    context.context.session = { ...current, session: normalized };
  }
});

/**
 * The complete session policy for a Better Auth instance.
 *
 * The input deliberately excludes the session database hook and the request
 * `before` hook. Callers may add hooks for other models and an unrelated
 * request `after` hook, but they cannot replace either absolute-cap boundary
 * while doing so.
 */
export function authSessionPolicy({
  databaseHooks = {},
  hooks = {},
}: AuthSessionPolicyInput = {}): AuthSessionPolicy {
  return {
    session: {
      expiresIn: SESSION_IDLE_SECONDS,
      updateAge: SESSION_SLIDE_SECONDS,
      freshAge: SESSION_FRESH_AGE_SECONDS,
    },
    hooks: {
      ...hooks,
      before: absoluteLifetimeGuard,
    },
    databaseHooks: {
      ...databaseHooks,
      session: {
        update: {
          before: async (update, context) => {
            if (update.expiresAt === undefined) return;

            // Better Auth sends only the changed fields to an update hook. The
            // immutable origin is on the authoritative session that its request
            // middleware placed in context immediately before the slide.
            const createdAt = context?.context.session?.session.createdAt;
            const createdMs = createdAt instanceof Date ? createdAt.getTime() : Number.NaN;
            const proposedMs = update.expiresAt.getTime();
            if (!Number.isFinite(createdMs) || !Number.isFinite(proposedMs)) return false;

            const idleDeadlineMs = Date.now() + SESSION_IDLE_SECONDS * 1000;
            const absoluteDeadlineMs = absoluteSessionDeadlineMs(createdMs);
            return {
              data: {
                ...update,
                expiresAt: new Date(Math.min(proposedMs, idleDeadlineMs, absoluteDeadlineMs)),
              },
            };
          },
        },
      },
    },
  };
}

/** Read-only view of the numbers, for tests and for `docs/reference/auth.md`. */
export const SESSION_LIFETIME_SECONDS = {
  idle: SESSION_IDLE_SECONDS,
  slide: SESSION_SLIDE_SECONDS,
  fresh: SESSION_FRESH_AGE_SECONDS,
  absoluteMax: SESSION_ABSOLUTE_MAX_SECONDS,
} as const;
