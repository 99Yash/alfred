import { auth } from "@alfred/auth";
import { isPastAbsoluteLifetime, revokeSessionByToken } from "@alfred/auth/session-policy";
import { toMessage } from "@alfred/contracts";

type Session = Awaited<ReturnType<ReturnType<typeof auth>["api"]["getSession"]>>;

const perRequest = new WeakMap<Request, Promise<Session>>();

const TOKEN_TTL_MS = 10_000;
const MAX_TOKEN_CACHE_SIZE = 1_000;
const tokenCache = new Map<string, { session: Session; expiresAt: number }>();
const tokenInflight = new Map<string, Promise<Session>>();

const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of tokenCache) {
    if (entry.expiresAt <= now) tokenCache.delete(key);
  }
}, 60_000);
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

/**
 * The one place Alfred's absolute session cap is applied (#454).
 *
 * Better Auth slides `expires_at` forward on every use and offers no option
 * that bounds the total, so the cap lives here — on the read path every route
 * handler goes through. Passing the cap REVOKES the row rather than returning
 * "no session" for this one request: Better Auth's own mounted routes read the
 * same table, so deleting the row is what makes the cap hold on paths this
 * function never sees.
 *
 * Residual gap, deliberately accepted: a stolen cookie that only ever replays
 * Better Auth's own management routes (`/list-sessions`, `/revoke-session`,
 * `/update-user`) and never touches an Alfred route is not capped, because
 * nothing calls this. Those routes reach no mail, no Drive, and no Alfred data.
 * The web app calls `/api/auth/get-session` on load and on focus, and that route
 * DOES go through here.
 */
async function fetchSession(request: Request): Promise<Session> {
  const session = await auth().api.getSession({ headers: request.headers });
  if (!session) return null;
  if (!isPastAbsoluteLifetime(session.session.createdAt)) return session;
  try {
    await revokeSessionByToken(session.session.token);
  } catch (err) {
    // Deny either way. A failed delete leaves the row for the next read to try
    // again; honouring the cookie because the cleanup failed would invert the
    // whole point of the cap.
    console.warn("[auth] could not revoke a session past its absolute cap:", toMessage(err));
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
      perRequest.set(request, inflight);
      return inflight;
    }

    const base = fetchSession(request);
    const promise = base.then((session) => {
      if (tokenCache.size >= MAX_TOKEN_CACHE_SIZE) {
        const oldest = tokenCache.keys().next().value;
        if (oldest) tokenCache.delete(oldest);
      }
      tokenCache.set(token, { session, expiresAt: Date.now() + TOKEN_TTL_MS });
      return session;
    });

    // Evict from the inflight map on BOTH outcomes. A failed lookup (transient
    // DB/network blip) must remove the rejected promise rather than memoize it
    // — otherwise every later request with the same token replays the same
    // rejection and the user is locked out of all routes until restart. The
    // side handle on `base` keeps the eviction independent of `promise`'s
    // own rejection (which callers await + handle) and avoids an
    // unhandled-rejection warning.
    base.catch(() => {}).finally(() => tokenInflight.delete(token));

    tokenInflight.set(token, promise);
    perRequest.set(request, promise);
    return promise;
  }

  const promise = fetchSession(request);
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
 * `invalidateSessionToken` can only reach the token the request carries, which
 * is the wrong one for "sign out everywhere": that control revokes sessions
 * whose tokens this request does not hold, and each of those would otherwise
 * keep answering from this cache for up to {@link TOKEN_TTL_MS}. Alfred has one
 * user, so dropping the whole map costs one extra database read per live token
 * and buys a revocation that takes effect at once in this process.
 */
export function clearSessionTokenCache(): void {
  tokenCache.clear();
  tokenInflight.clear();
}
