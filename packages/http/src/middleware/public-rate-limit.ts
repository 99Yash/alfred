import { logger } from "@alfred/logging";
import { rateLimitClientAddress } from "@alfred/auth/rate-limit";
import { Errors, isApiError } from "@alfred/contracts";
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

/** A hook, not a handler call, so a new route on the same instance inherits the limit. */
export function publicRateLimit(bucket: string): Elysia {
  return new Elysia({ name: `public-rate-limit-${bucket}` }).onBeforeHandle(async ({ request }) => {
    const caller = rateLimitClientAddress(request);
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

      logger.warn({ err }, "[sharing] public rate limit unavailable");
    }
  });
}
