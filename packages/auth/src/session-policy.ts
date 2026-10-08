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
 * Session lifetime (#454). Three values restate Better Auth defaults so a library
 * change cannot move them. Better Auth has no absolute cap, so a cookie in use
 * would renew forever; {@link SESSION_ABSOLUTE_MAX_SECONDS} adds one.
 */

/** Idle timeout. The real window is this minus up to {@link SESSION_SLIDE_SECONDS}. */
const SESSION_IDLE_SECONDS = 60 * 60 * 24 * 7;

/** Write throttle: the expiry moves forward at most once per this period. */
const SESSION_SLIDE_SECONDS = 60 * 60 * 24;

/**
 * How long after sign-in a session is "fresh". Measured from `created_at`, so only
 * a new sign-in is fresh. See `docs/reference/auth.md`.
 */
const SESSION_FRESH_AGE_SECONDS = 60 * 60 * 24;

/** Max session age from sign-in. No refresh path changes `created_at`, so it is a safe origin. */
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

  // Better Auth returns a clamped session without checking the clamp is already past,
  // so remove an expired row here, before any endpoint reads it.
  const current = await context.context.internalAdapter.findSession(token);

  if (!current) return;

  const deadlineMs = absoluteSessionDeadlineMs(current.session.createdAt.getTime());

  if (!Number.isFinite(deadlineMs) || Date.now() >= deadlineMs) {
    // The delete can silently do nothing, so always reject.
    await context.context.internalAdapter.deleteSession(token);
    throw new APIError("UNAUTHORIZED");
  }

  if (current.session.expiresAt.getTime() > deadlineMs) {
    // An older row can expire after the cap. Clamp it before the endpoint reads it.
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

/** The input type excludes the session hook and the `before` hook, so a caller cannot replace the cap. */
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

            // The update has only changed fields; `createdAt` comes from the session in context.
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
