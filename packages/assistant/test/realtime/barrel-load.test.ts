import assert from "node:assert/strict";
import test from "node:test";

/**
 * The `@alfred/assistant/realtime` barrel is a module-evaluation unit that several
 * packages sit on top of. Two properties must hold for every one of them:
 *
 * 1. Importing it reads no environment, opens no connection and arms no timer. Every
 *    connection and every timer belongs to one of the four lifecycle functions. The
 *    no-throw assertion below catches the env read, and the handle delta catches the
 *    timer and the open socket; a constructed-but-idle `pg.Pool` opens no handle and is
 *    not detectable here.
 * 2. The barrel is exactly nine names. Anything wider hands a caller a door into
 *    the relay, the reaper or the `PeriodicTask` primitive, which are module-internal.
 */

const BARREL_EXPORTS = [
  "closeEventBridge",
  "closeReplicachePokeBridge",
  "emitReplicachePokesOverRedis",
  "getEventsSince",
  "getReplayHighWatermark",
  "initEventBridge",
  "initReplicachePokeBridge",
  "subscribeUserEvents",
  "subscribeUserPokes",
];

/**
 * A timer is a `Timeout`; an open Redis or Postgres socket is a `TCP*` or `TLS*` handle.
 * Everything else `getActiveResourcesInfo()` reports here belongs to the test runner or
 * to the tsx loader's own file reads (`FSReqPromise`, `PipeWrap`, `ConnectWrap`), whose
 * counts move on their own between two calls and would make this test flaky.
 */
function isTimerOrConnection(kind: string): boolean {
  return kind === "Timeout" || kind.startsWith("TCP") || kind.startsWith("TLS");
}

/** Counts each watched resource type so a delta reads as "how many more of each kind". */
function timerAndConnectionCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const kind of process.getActiveResourcesInfo()) {
    if (!isTimerOrConnection(kind)) continue;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return counts;
}

test("realtime barrel loads with no database and no redis configured", async () => {
  // `serverEnv()` is all-or-nothing, so removing these two keys is enough to make a
  // module-scope env read throw; a module-scope `createRedisConnection()` needs REDIS_URL.
  delete process.env["DATABASE_URL"];
  delete process.env["REDIS_URL"];

  // A no-throw assertion cannot see an armed timer: `setInterval` needs no environment
  // and `--test-force-exit` removes the "the runner hangs on a live handle" backstop.
  // `getActiveResourcesInfo()` names the handle, so a module-scope `setInterval` shows up
  // as a `Timeout` and a connected socket as a `TCP*` handle. An idle `new pg.Pool()`
  // opens nothing and is NOT covered here — see the module's own comment for that half.
  const before = timerAndConnectionCounts();

  const ns = await import("../../src/realtime/index");

  const after = timerAndConnectionCounts();
  for (const [kind, count] of after) {
    assert.ok(
      count <= (before.get(kind) ?? 0),
      `importing the realtime barrel armed a new ${kind} handle; every timer and every ` +
        `open connection belongs inside a lifecycle function`,
    );
  }

  assert.deepEqual(Object.keys(ns).sort(), BARREL_EXPORTS);
  for (const [name, value] of Object.entries(ns)) {
    assert.equal(typeof value, "function", `${name} should be a function`);
  }
});
