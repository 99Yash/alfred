import { auth } from "@alfred/auth";

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

async function fetchSession(request: Request): Promise<Session> {
  return auth().api.getSession({ headers: request.headers });
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

    const promise = fetchSession(request).then((session) => {
      if (tokenCache.size >= MAX_TOKEN_CACHE_SIZE) {
        const oldest = tokenCache.keys().next().value;
        if (oldest) tokenCache.delete(oldest);
      }
      tokenCache.set(token, { session, expiresAt: Date.now() + TOKEN_TTL_MS });
      tokenInflight.delete(token);
      return session;
    });

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
