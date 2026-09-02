import { auth } from "@alfred/auth";

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
// eslint-disable-next-line anti-slop/no-runtime-typeof -- platform capability check: Node's setInterval returns an object with unref, browsers return a number; not domain parsing
if (typeof sweepTimer === "object" && "unref" in sweepTimer) sweepTimer.unref();

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
      // A successful auth mutation can clear the cache while this lookup is
      // still pending. Its existing waiter may receive the result, but the old
      // generation must not repopulate shared state after invalidation.
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

    // Evict from the inflight map on BOTH outcomes. A failed lookup (transient
    // DB/network blip) must remove the rejected promise rather than memoize it
    // — otherwise every later request with the same token replays the same
    // rejection and the user is locked out of all routes until restart. The
    // side handle on `base` keeps the eviction independent of `promise`'s
    // own rejection (which callers await + handle) and avoids an
    // unhandled-rejection warning.
    base
      .catch(() => {})
      .finally(() => {
        // A clear can let a new request install another promise for this token
        // before the old lookup settles. Only remove the promise we installed.
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

/**
 * Drop every cached token.
 *
 * Successful Better Auth POSTs can create, update, or revoke any session on the
 * account. The HTTP composition calls this after the handler returns success,
 * so a new or renamed mutation cannot bypass invalidation through a stale route
 * list. Alfred has one user, so dropping the whole map costs one extra database
 * read per live token and buys an auth mutation that takes effect at once in
 * this process.
 */
export function clearSessionTokenCache(): void {
  tokenCacheGeneration += 1;
  tokenCache.clear();
  tokenInflight.clear();
}
