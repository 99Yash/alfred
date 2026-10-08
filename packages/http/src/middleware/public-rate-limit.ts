import { Errors, isApiError, toMessage } from "@alfred/contracts";
import {
  createRedisConnection,
  incrementExpiringCounter,
  type BoundedRedis,
} from "@alfred/db/redis";
import { Elysia } from "elysia";

/**
 * Per-IP limit for routes with no session (ADR-0102). A cost control, not access
 * control: one known slug reads a whole transcript. Fails open if Redis is down.
 */

const MAX_REQUESTS_PER_WINDOW = 60;

const WINDOW_SECONDS = 60;

let publicRateRedis: BoundedRedis | undefined;

function getPublicRateRedis(): BoundedRedis {
  // Not "fail-fast": it rejects the first command even on a healthy Redis.
  publicRateRedis ??= createRedisConnection("command");

  return publicRateRedis;
}

/** Railway-internal proxy hops. Same list as `TRUSTED_PROXY_RANGES` in `packages/auth/src/rate-limit.ts`. */
const INFRASTRUCTURE_PREFIXES = ["10.", "192.168.", "127.", "100.", "::1", "fd", "fc"] as const;

function isInfrastructureHop(address: string): boolean {
  if (address.startsWith("172.")) {
    const second = Number(address.split(".")[1]);

    return Number.isInteger(second) && second >= 16 && second <= 31;
  }

  return INFRASTRUCTURE_PREFIXES.some((prefix) => address.startsWith(prefix));
}

/**
 * The caller's address, read right to left from `x-forwarded-for`.
 * The leftmost entry is client-controlled, so reading it lets a caller spoof a fresh bucket.
 * `null` puts the caller in one shared bucket.
 */
export function clientAddressFromForwardedFor(header: string | null | undefined): string | null {
  if (!header) return null;

  const hops = header
    .split(",")
    .map((hop) => hop.trim())
    .filter((hop) => hop.length > 0);

  for (let i = hops.length - 1; i >= 0; i--) {
    // SAFETY: `i` indexes inside the array it was measured from.
    const hop = hops[i]!;

    if (!isInfrastructureHop(hop)) return hop;
  }

  return null;
}

/** A hook, not a handler call, so a new route on the same instance inherits the limit. */
export function publicRateLimit(bucket: string): Elysia {
  return new Elysia({ name: `public-rate-limit-${bucket}` }).onBeforeHandle(async ({ request }) => {
    const caller = clientAddressFromForwardedFor(request.headers.get("x-forwarded-for"));
    const window = Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
    const key = `ratelimit:public:${bucket}:${caller ?? "unknown"}:${window}`;

    try {
      const count = await incrementExpiringCounter(
        getPublicRateRedis(),
        key,
        1,
        // Two windows, so a key made late in a window lives to its end.
        WINDOW_SECONDS * 2,
      );

      if (count > MAX_REQUESTS_PER_WINDOW) {
        throw Errors.TooManyRequestsError("Too many requests. Try again in a minute.", {
          retryAfterSeconds: WINDOW_SECONDS,
        });
      }
    } catch (err) {
      // Rethrow our own 429; only a Redis error fails open.
      if (isApiError(err, "TOO_MANY_REQUESTS")) throw err;

      console.warn("[sharing] public rate limit unavailable:", toMessage(err));
    }
  });
}
