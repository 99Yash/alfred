import { auth } from "@alfred/auth";
import { unrefTimer } from "@alfred/contracts";

type Session = Awaited<ReturnType<ReturnType<typeof auth>["api"]["getSession"]>>;

const perRequest = new WeakMap<Request, Promise<Session>>();

const TOKEN_TTL_MS = 10_000;

const MAX_TOKEN_CACHE_SIZE = 1_000;

const tokenCache = new Map<string, { session: Session; expiresAt: number }>();

const tokenInflight = new Map<string, Promise<Session>>();

let tokenCacheGeneration = 0;

async function resolveUnexpiredSession(promise: Promise<Session>): Promise<Session> {
  const session = await promise;

  if (session && session.session.expiresAt.getTime() <= Date.now()) return null;

  return session;
}

const sweepTimer = setInterval(() => {
  const now = Date.now();

  for (const [key, entry] of tokenCache) {
    if (entry.expiresAt <= now) tokenCache.delete(key);
  }
}, 60_000);

unrefTimer(sweepTimer);

const SESSION_COOKIE_NAMES = new Set([
  "better-auth.session_token",
  "__Secure-better-auth.session_token",
  "__Host-better-auth.session_token",
]);

function extractSessionToken(headers: Headers): string | null {
  const cookieHeader = headers.get("cookie") ?? "";

  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");

    if (name && SESSION_COOKIE_NAMES.has(name.trim())) {
      return rest.join("=").trim();
    }
  }

  return null;
}

export async function getSessionCached(request: Request): Promise<Session> {
  const existing = perRequest.get(request);

  if (existing) return existing;

  const token = extractSessionToken(request.headers);

  if (token) {
    const cached = tokenCache.get(token);

    if (cached && cached.expiresAt > Date.now()) {
      const promise = Promise.resolve(cached.session);
      perRequest.set(request, promise);

      return promise;
    }

    const inflight = tokenInflight.get(token);

    if (inflight) {
      const promise = resolveUnexpiredSession(inflight);
      perRequest.set(request, promise);

      return promise;
    }

    const generation = tokenCacheGeneration;
    const base = auth().api.getSession({ headers: request.headers });

    const promise = base.then((session) => {
      // A clear during the lookup bumps the generation; the stale result must not refill the cache.
      if (generation !== tokenCacheGeneration) return session;

      if (tokenCache.size >= MAX_TOKEN_CACHE_SIZE) {
        const oldest = tokenCache.keys().next().value;

        if (oldest) tokenCache.delete(oldest);
      }

      const ttlDeadline = Date.now() + TOKEN_TTL_MS;

      const expiresAt = session
        ? Math.min(ttlDeadline, session.session.expiresAt.getTime())
        : ttlDeadline;

      tokenCache.set(token, { session, expiresAt });

      return session;
    });

    // Evict on both outcomes: a memoized rejection would lock the user out until restart.
    // The `.catch` on `base` avoids an unhandled-rejection warning.
    base
      .catch(() => {})
      .finally(() => {
        // After a clear, a newer promise may own this token. Remove only ours.
        if (tokenInflight.get(token) === promise) tokenInflight.delete(token);
      });

    tokenInflight.set(token, promise);
    const checked = resolveUnexpiredSession(promise);
    perRequest.set(request, checked);

    return checked;
  }

  const promise = auth().api.getSession({ headers: request.headers });
  perRequest.set(request, promise);

  return promise;
}

export function invalidateSessionToken(headers: Headers): void {
  const token = extractSessionToken(headers);

  if (token) {
    tokenCache.delete(token);
    tokenInflight.delete(token);
  }
}

/** Drop every cached token after any successful Better Auth POST. Cheap with one user. */
export function clearSessionTokenCache(): void {
  tokenCacheGeneration += 1;
  tokenCache.clear();
  tokenInflight.clear();
}
