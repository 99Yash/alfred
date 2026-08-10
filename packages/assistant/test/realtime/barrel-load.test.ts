import assert from "node:assert/strict";
import test from "node:test";

/**
 * The `@alfred/assistant/realtime` barrel is a module-evaluation unit that several
 * packages sit on top of. Two properties must hold for every one of them:
 *
 * 1. Importing it reads no environment, opens no Postgres pool, opens no Redis
 *    connection and arms no timer. Every connection and every timer belongs to one
 *    of the four lifecycle functions.
 * 2. The barrel is exactly nine names. Anything wider hands a caller a door into
 *    the relay, the reaper or the `PeriodicTask` primitive, which are module-internal.
 */

const BARREL_EXPORTS = [
  "closeEventBridge",
  "closeReplicachePokeBridge",
  "emitReplicachePokes",
  "getEventsSince",
  "getReplayHighWatermark",
  "initEventBridge",
  "initReplicachePokeBridge",
  "subscribeUserEvents",
  "subscribeUserPokes",
];

test("realtime barrel loads with no database and no redis configured", async () => {
  // `serverEnv()` is all-or-nothing, so removing these two keys is enough to make a
  // module-scope env read throw; a module-scope `createRedisConnection()` needs REDIS_URL.
  delete process.env["DATABASE_URL"];
  delete process.env["REDIS_URL"];

  const ns = await import("../../src/realtime/index");

  assert.deepEqual(Object.keys(ns).sort(), BARREL_EXPORTS);
  for (const name of BARREL_EXPORTS) {
    assert.equal(
      typeof (ns as Record<string, unknown>)[name],
      "function",
      `${name} should be a function`,
    );
  }
});
