import assert from "node:assert/strict";
import { isIP } from "node:net";
import { describe, test } from "node:test";
import { ensureAuthTestEnv } from "./support/env";
import { authIpAddress, authRateLimit, createAuthRateLimitStorage } from "../src/rate-limit";

/**
 * The auth rate limit counts in Redis, not in one process.
 * Config cases read `auth().options`, because a store not wired in limits nothing.
 */

const RULE = { window: 10, max: 2 };

/** A Redis that records what it was asked to do. */
function fakeRedis() {
  const values = new Map<string, number>();
  const evalCalls: Array<{ key: string; args: (string | number)[] }> = [];

  return {
    values,
    evalCalls,
    conn: {
      eval: async (_script: string, _numkeys: number, ...args: (string | number)[]) => {
        const key = args[0] as string;
        const amount = args[1] as number;
        const ttl = args[2] as number;
        evalCalls.push({ key, args });
        const next = (values.get(key) ?? 0) + amount;
        values.set(key, next);

        if (next === amount) {
          values.set(`${key}:ttl`, ttl);
        }

        return next;
      },
    },
  };
}

/** Silences the outage warning during a deliberate failure. */
async function withoutWarnings<T>(run: () => Promise<T>): Promise<{ result: T; warnings: number }> {
  const original = console.warn;
  let warnings = 0;
  console.warn = () => {
    warnings += 1;
  };

  try {
    return { result: await run(), warnings };
  } finally {
    console.warn = original;
  }
}

describe("auth rate limit storage (#458)", () => {
  test("counts one window in Redis and refuses past the max", async () => {
    const redis = fakeRedis();
    const storage = createAuthRateLimitStorage(() => redis.conn);

    const first = await storage.consume("203.0.113.7|/sign-in/social", RULE);
    const second = await storage.consume("203.0.113.7|/sign-in/social", RULE);
    const third = await storage.consume("203.0.113.7|/sign-in/social", RULE);

    assert.deepEqual(first, { allowed: true, retryAfter: null });
    assert.deepEqual(second, { allowed: true, retryAfter: null });
    assert.equal(third.allowed, false);
    // The window is fixed, so the wait is never longer than the window itself.
    assert.ok(
      third.retryAfter !== null && third.retryAfter >= 1 && third.retryAfter <= RULE.window,
      `retryAfter out of range: ${third.retryAfter}`,
    );
  });

  test("expires the counter once, when the window opens", async () => {
    const redis = fakeRedis();
    const storage = createAuthRateLimitStorage(() => redis.conn);

    await storage.consume("203.0.113.7|/sign-in/social", RULE);
    await storage.consume("203.0.113.7|/sign-in/social", RULE);

    // The script sets a TTL only on a new key, so the window does not slide.
    assert.equal(redis.evalCalls.length, 2);
    const ttlEntries = [...redis.values.entries()].filter(([k]) => k.endsWith(":ttl"));
    assert.equal(ttlEntries.length, 1, "EXPIRE must set TTL exactly once");
    assert.equal(ttlEntries[0]?.[1], RULE.window);
  });

  test("addresses a key per window, so a stale counter cannot outlive one", async () => {
    const redis = fakeRedis();
    const storage = createAuthRateLimitStorage(() => redis.conn);

    const before = Math.floor(Date.now() / (RULE.window * 1000));
    await storage.consume("203.0.113.7|/sign-in/social", RULE);
    const after = Math.floor(Date.now() / (RULE.window * 1000));

    const [key] = [...redis.values.keys()];
    assert.ok(key, "no key was written");
    // Either index: the clock can cross a window between the call and the read.
    assert.ok(
      key === `rate:auth:203.0.113.7|/sign-in/social:${before}` ||
        key === `rate:auth:203.0.113.7|/sign-in/social:${after}`,
      `unexpected key: ${key}`,
    );
  });

  test("keeps counting in memory while Redis is unreachable", async () => {
    const unreachable = () => {
      throw new Error("connect ECONNREFUSED");
    };

    const storage = createAuthRateLimitStorage(unreachable);

    const { result, warnings } = await withoutWarnings(async () => [
      await storage.consume("203.0.113.7|/sign-in/social", RULE),
      await storage.consume("203.0.113.7|/sign-in/social", RULE),
      await storage.consume("203.0.113.7|/sign-in/social", RULE),
    ]);

    // An outage must neither lift the limit nor lock out the only user.
    assert.equal(result[0]?.allowed, true);
    assert.equal(result[1]?.allowed, true);
    assert.equal(result[2]?.allowed, false);
    assert.equal(warnings, 3, "each degraded request must say so");
  });
});

describe("auth rate limit configuration (#458)", () => {
  test("the auth instance takes an explicit window, max and Redis store", async () => {
    ensureAuthTestEnv();
    const { auth } = await import("../src/index");
    const rateLimit = auth().options.rateLimit;
    assert.ok(rateLimit, "auth configures no rateLimit");
    assert.ok(rateLimit.customStorage, "auth falls back to the in-memory store");
    assert.equal(typeof rateLimit.window, "number", "auth leaves the window implicit");
    assert.equal(typeof rateLimit.max, "number", "auth leaves the max implicit");
    // Better Auth's stricter built-in path rules apply only with no custom rules.
    assert.equal(rateLimit.customRules, undefined, "auth overrides a stricter default");
  });

  test("the limiter is on in production and off in a dev or test run", () => {
    // Explicit, so a changed Better Auth default cannot turn it off.
    assert.equal(authRateLimit("production").enabled, true);
    assert.equal(authRateLimit("development").enabled, false);
    assert.equal(authRateLimit("test").enabled, false);
  });

  test("accepts only a validated server environment", () => {
    // @ts-expect-error NODE_ENV is the ServerEnv union, not an arbitrary string.
    const invalidNodeEnv: Parameters<typeof authRateLimit>[0] = "Production";
    assert.equal(invalidNodeEnv, "Production");
  });

  test("every trusted proxy entry is a valid IP or CIDR range", () => {
    const proxies = authIpAddress().trustedProxies;
    assert.ok(
      proxies && proxies.length > 0,
      "an empty list buckets every forwarded request as one",
    );

    for (const entry of proxies) {
      const slash = entry.lastIndexOf("/");
      const address = slash === -1 ? entry : entry.slice(0, slash);
      const family = isIP(address);
      // Better Auth silently drops an entry it cannot parse.
      assert.notEqual(family, 0, `not an IP address: ${entry}`);

      if (slash === -1) continue;
      const prefix = Number(entry.slice(slash + 1));
      assert.ok(
        Number.isInteger(prefix) && prefix >= 0 && prefix <= (family === 4 ? 32 : 128),
        `prefix out of range for the address family: ${entry}`,
      );
    }
  });
});
