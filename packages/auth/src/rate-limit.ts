import { toMessage } from "@alfred/contracts";
import { createRedisConnection, incrementExpiringCounter, type EvalRedis } from "@alfred/db/redis";
import type { ServerEnv } from "@alfred/env/server";
import type { BetterAuthOptions } from "better-auth";

/**
 * The rate limit Alfred's Better Auth instance runs on.
 *
 * Better Auth ships a limiter that is ON in production by default, but its
 * default store is a `Map` in the API process: the counter is per-process, it
 * is lost on every deploy and every restart, and a second replica gets its own
 * copy of every bucket. This module moves the counter into the Redis the API
 * already runs, so one bucket holds for the whole deployment (#458).
 *
 * Two things are deliberately NOT configured here.
 *
 * Per-endpoint limits stay Better Auth's own: `/sign-in`, `/sign-up`,
 * `/change-password` and `/change-email` are 3 requests per 10s, and the
 * password-reset and verification-email paths are 3 per 60s. Those are stricter
 * than the defaults below and they apply on top of them, so this file sets no
 * `customRules` — a rule declared here would REPLACE the special rule for that
 * path, which is how a "tightening" edit quietly loosens sign-in to 100/10s.
 *
 * The `rateLimit` database table is not used and not migrated. `customStorage`
 * wins over `storage` in Better Auth's own resolver, so the table-backed
 * backend is never reached.
 */

/**
 * Requests per {@link AUTH_RATE_LIMIT_WINDOW_SECONDS} for a path with no
 * stricter rule of its own. Both numbers restate Better Auth's defaults rather
 * than change them: the point of the issue was to make the store explicit, and
 * an explicit value is also what stops a library default from moving under us.
 */
const AUTH_RATE_LIMIT_MAX = 100;
const AUTH_RATE_LIMIT_WINDOW_SECONDS = 10;

/**
 * Reverse proxies whose hop in `x-forwarded-for` is not the client.
 *
 * Better Auth resolves the client IP by walking the forwarded chain from the
 * right and taking the first address that is not on this list. With the list
 * EMPTY it instead trusts a single-value header only, so any request carrying
 * its own `x-forwarded-for` resolves to no IP at all and lands in one shared
 * bucket with every other such request — which turns the sign-in limit into a
 * lever anyone can pull against the one real user.
 *
 * Better Auth's own guidance is to name the proxy's address instead of a broad
 * private range. Railway publishes no stable address for its edge, and the
 * container is reachable ONLY through that edge, so every hop between the
 * client and this process is on Railway's internal network. That is the same
 * reasoning, and the same range list, that the web service's `Caddyfile`
 * already uses (`private_ranges` plus `100.0.0.0/8`). If the API ever becomes
 * reachable without going through Railway's proxy, this list must go.
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
/** Better Auth's own row shape, derived rather than restated. */
type RateLimitRow = Parameters<RateLimitStorage["set"]>[1];

/**
 * The only Redis verbs this module issues, named as a port rather than as
 * `Pick<BoundedRedis, …>`: ioredis declares each of these across many
 * overloads, so a test double can satisfy this and cannot satisfy the picked
 * type without a cast. `getRateLimitRedis` below is what checks a real
 * connection still fits.
 *
 * Drift guard: an ioredis upgrade that changes `eval` or `get` or `set`
 * signatures breaks the assignment at `getRateLimitRedis` — the only call
 * site — because `BoundedRedis` no longer satisfies this port. The break
 * surfaces at `check-types` time, not in production.
 */
type RateLimitRedis = {
  eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
};

let rateLimitRedis: RateLimitRedis | undefined;

function getRateLimitRedis(): RateLimitRedis {
  // `"command"`, not `"fail-fast"`: this counter IS the limit, nothing else can
  // answer for it, and a `"fail-fast"` handle rejects its first command after
  // construction even against a healthy Redis — see the decision test in
  // `packages/db/src/redis.ts`.
  rateLimitRedis ??= createRedisConnection("command");
  return rateLimitRedis;
}

/**
 * A fixed window, addressed by the window it falls in rather than by a stored
 * timestamp. The bucket index is derived from the clock, so a counter whose
 * `EXPIRE` never landed cannot outlive its window: the next window is a
 * different key. That is the same shape as the attachment upload quota in
 * `packages/assistant/src/chat/attachment-upload-quota.ts`.
 */
function bucketFor(key: string, windowSeconds: number, nowMs: number) {
  const windowMs = windowSeconds * 1000;
  const index = Math.floor(nowMs / windowMs);
  return { key: `rate:auth:${key}:${index}`, endsAtMs: (index + 1) * windowMs };
}

/**
 * Per-process counters, used only while Redis is unreachable.
 *
 * A rate limiter that switches itself off during an outage is a worse posture
 * than one that degrades, and failing CLOSED here would lock the only user out
 * of their own assistant over a Redis blip on the one path that has no other
 * way in. So a Redis failure falls back to counting in memory, which is exactly
 * the limiter Better Auth would have run without this module.
 */
const MAX_FALLBACK_ENTRIES = 10_000;

function createFallbackStore() {
  const entries = new Map<string, { count: number; expiresAtMs: number }>();

  function prune(nowMs: number): void {
    for (const [key, entry] of entries) if (nowMs >= entry.expiresAtMs) entries.delete(key);
    // A caller with many source addresses can still outrun the window, so the
    // map is capped as well. Iteration order is insertion order, so this drops
    // the oldest buckets first.
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
    read(key: string, nowMs: number): number | null {
      prune(nowMs);
      return entries.get(key)?.count ?? null;
    },
    write(key: string, count: number, expiresAtMs: number, nowMs: number): void {
      prune(nowMs);
      entries.set(key, { count, expiresAtMs });
    },
  };
}

/**
 * One fallback instance is shared across every storage object created in this
 * process, so a reconstruction during an outage does not reset the counter.
 */
const sharedFallback = createFallbackStore();

/**
 * The store Better Auth calls. `redis` is a parameter so the outage path can be
 * exercised by a test without an unreachable Redis. `fallback` is shared by
 * default so reconstructed auth storage keeps counting in the same bucket
 * during an outage; a test can supply its own.
 */
export function createAuthRateLimitStorage(
  redis: () => RateLimitRedis = getRateLimitRedis,
  fallback = sharedFallback,
): RateLimitStorage {
  function degrade(err: unknown): void {
    console.warn("[auth] rate limit store unavailable, counting in memory:", toMessage(err));
  }

  return {
    /**
     * One request counted, and the answer, in a single step. Better Auth calls
     * this and nothing else while it exists; `get`/`set` below are its legacy
     * non-atomic path, which it takes only for a store without a `consume`.
     */
    consume: async (key, rule) => {
      const nowMs = Date.now();
      const bucket = bucketFor(key, rule.window, nowMs);
      let count: number;
      try {
        // SAFETY: RateLimitRedis carries eval (the drift-guard comment in
        // @alfred/db/redis pins it); EvalRedis names that single-command
        // subset incrementExpiringCounter uses.
        count = await incrementExpiringCounter(redis() as EvalRedis, bucket.key, 1, rule.window);
      } catch (err) {
        degrade(err);
        count = fallback.increment(bucket.key, bucket.endsAtMs, nowMs);
      }
      if (count <= rule.max) return { allowed: true, retryAfter: null };
      const retryAfter = Math.max(1, Math.ceil((bucket.endsAtMs - nowMs) / 1000));
      return { allowed: false, retryAfter };
    },

    /**
     * Legacy non-atomic path. Better Auth takes this only for a store without
     * `consume`; it never fires while `consume` is present. `get` and `set`
     * receive no `rule`, so the window must be a module constant. That is safe
     * today because `consume` short-circuits the legacy path, but would become
     * a latent bug if Better Auth started calling `get`/`set` with custom-rule
     * windows.
     */
    get: async (key): Promise<RateLimitRow | null> => {
      const nowMs = Date.now();
      const bucket = bucketFor(key, AUTH_RATE_LIMIT_WINDOW_SECONDS, nowMs);
      // The stored value is a bare counter, so `lastRequest` is the start of the
      // window it belongs to. Better Auth's caller only asks whether that start
      // is still inside the window, which is true for exactly this window.
      const lastRequest = bucket.endsAtMs - AUTH_RATE_LIMIT_WINDOW_SECONDS * 1000;
      let raw: string | null;
      try {
        raw = await redis().get(bucket.key);
      } catch (err) {
        degrade(err);
        const counted = fallback.read(bucket.key, nowMs);
        return counted === null ? null : { key, count: counted, lastRequest };
      }
      const count = raw === null ? Number.NaN : Number.parseInt(raw, 10);
      if (!Number.isFinite(count)) return null;
      return { key, count, lastRequest };
    },

    set: async (key, value): Promise<void> => {
      const nowMs = Date.now();
      const bucket = bucketFor(key, AUTH_RATE_LIMIT_WINDOW_SECONDS, nowMs);
      try {
        await redis().set(bucket.key, String(value.count), "EX", AUTH_RATE_LIMIT_WINDOW_SECONDS);
      } catch (err) {
        degrade(err);
        fallback.write(bucket.key, value.count, bucket.endsAtMs, nowMs);
      }
    },
  };
}

/**
 * The `rateLimit` block for Alfred's Better Auth instance.
 */
export function authRateLimit(nodeEnv: ServerEnv["NODE_ENV"]): RateLimitOptions {
  return {
    // Better Auth's own default, restated so a change to that default cannot
    // move it. Development and test stay OFF deliberately: a dev loop and a
    // suite both replay one route far faster than a person does, which is the
    // exact traffic shape a limiter refuses. The store below is covered by
    // `test/rate-limit.test.ts` instead of by a local sign-in.
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
