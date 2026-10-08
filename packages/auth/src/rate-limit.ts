import { toMessage } from "@alfred/contracts";
import { createRedisConnection, incrementExpiringCounter } from "@alfred/db/redis";
import type { ServerEnv } from "@alfred/env/server";
import type { BetterAuthOptions } from "better-auth";

/**
 * Better Auth's rate limit, counted in Redis so it survives restarts and spans processes (#458).
 * No `customRules`: one would replace Better Auth's stricter per-path rule, e.g. sign-in 3 per 10s.
 * The `rateLimit` table is unused because `customStorage` wins.
 */

/** Better Auth's defaults, restated so a library change cannot move them. */
const AUTH_RATE_LIMIT_MAX = 100;

const AUTH_RATE_LIMIT_WINDOW_SECONDS = 10;

/**
 * Proxy hops to skip in `x-forwarded-for`. With an empty list, a spoofed header puts
 * every caller in one bucket, so anyone could lock out the real user.
 * Safe only while the API is reachable only through Railway's proxy. Matches the `Caddyfile`.
 */
const TRUSTED_PROXY_RANGES = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "127.0.0.0/8",
  "100.0.0.0/8",
  "::1/128",
  "fd00::/8",
] as const;

type RateLimitOptions = NonNullable<BetterAuthOptions["rateLimit"]>;

type RateLimitStorage = NonNullable<RateLimitOptions["customStorage"]>;

/** Not `Pick<BoundedRedis, …>`: ioredis overloads stop a test double from matching that. */
type RateLimitRedis = {
  eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>;
};

let rateLimitRedis: RateLimitRedis | undefined;

function getRateLimitRedis(): RateLimitRedis {
  // Not `"fail-fast"`: that handle rejects its first command even when Redis is healthy.
  rateLimitRedis ??= createRedisConnection("command");

  return rateLimitRedis;
}

/** The key includes the window index, so a counter whose `EXPIRE` failed still cannot outlive it. */
function bucketFor(key: string, windowSeconds: number, nowMs: number) {
  const windowMs = windowSeconds * 1000;
  const index = Math.floor(nowMs / windowMs);

  return { key: `rate:auth:${key}:${index}`, endsAtMs: (index + 1) * windowMs };
}

/** In-memory counting while Redis is down. Failing closed would lock the only user out. */
const MAX_FALLBACK_ENTRIES = 10_000;

function createFallbackStore() {
  const entries = new Map<string, { count: number; expiresAtMs: number }>();

  function prune(nowMs: number): void {
    for (const [key, entry] of entries) if (nowMs >= entry.expiresAtMs) entries.delete(key);
    // Cap the map too. Insertion order means the oldest buckets go first.
    let overflow = entries.size - MAX_FALLBACK_ENTRIES;

    for (const key of entries.keys()) {
      if (overflow <= 0) break;
      entries.delete(key);
      overflow -= 1;
    }
  }

  return {
    increment(key: string, expiresAtMs: number, nowMs: number): number {
      prune(nowMs);
      const current = entries.get(key);
      const count = (current?.count ?? 0) + 1;
      entries.set(key, { count, expiresAtMs });

      return count;
    },
  };
}

/** Shared, so building a new store during an outage does not reset the count. */
const sharedFallback = createFallbackStore();

/** `redis` and `fallback` are parameters so tests can drive the outage path. */
export function createAuthRateLimitStorage(
  redis: () => RateLimitRedis = getRateLimitRedis,
  fallback = sharedFallback,
): RateLimitStorage {
  function degrade(err: unknown): void {
    console.warn("[auth] rate limit store unavailable, counting in memory:", toMessage(err));
  }

  return {
    /** Count and decide in one atomic step. A read then a write cannot hold a shared limit. */
    consume: async (key, rule) => {
      const nowMs = Date.now();
      const bucket = bucketFor(key, rule.window, nowMs);
      let count: number;

      try {
        count = await incrementExpiringCounter(redis(), bucket.key, 1, rule.window);
      } catch (err) {
        degrade(err);
        count = fallback.increment(bucket.key, bucket.endsAtMs, nowMs);
      }

      if (count <= rule.max) return { allowed: true, retryAfter: null };
      const retryAfter = Math.max(1, Math.ceil((bucket.endsAtMs - nowMs) / 1000));

      return { allowed: false, retryAfter };
    },
  };
}

export function authRateLimit(nodeEnv: ServerEnv["NODE_ENV"]): RateLimitOptions {
  return {
    // Off in dev and test: both repeat one route faster than a person would.
    enabled: nodeEnv === "production",
    window: AUTH_RATE_LIMIT_WINDOW_SECONDS,
    max: AUTH_RATE_LIMIT_MAX,
    customStorage: createAuthRateLimitStorage(),
  };
}

/** The `advanced.ipAddress` block. See {@link TRUSTED_PROXY_RANGES}. */
export function authIpAddress(): NonNullable<
  NonNullable<BetterAuthOptions["advanced"]>["ipAddress"]
> {
  return { trustedProxies: [...TRUSTED_PROXY_RANGES] };
}
