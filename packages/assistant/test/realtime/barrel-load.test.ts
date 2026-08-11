import assert from "node:assert/strict";
import test from "node:test";

/**
 * The `@alfred/assistant/realtime` barrel is a module-evaluation unit that several
 * packages sit on top of. Two properties must hold for every one of them:
 *
 * 1. Importing it reads no environment, opens no connection and arms no timer. Every
 *    timer, and every connection the module opens itself, belongs to one of the four
 *    lifecycle functions. Three detectors, one per shape: the no-throw assertion catches
 *    an env read, the timer-arm count catches any `setInterval` / `setTimeout` the import
 *    schedules, and the handle delta catches a socket the import connects. A
 *    constructed-but-idle `pg.Pool` opens no handle and arms no timer, so that one shape
 *    is not detectable here at all.
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

/**
 * Runs `body` with `setInterval` and `setTimeout` counted, and reports every arm.
 *
 * A handle delta cannot do this job. `getActiveResourcesInfo()` does not report an
 * unref'd timer, and `PeriodicTask.start()` unrefs its interval unconditionally
 * (`periodic-task.ts:94`), so the one timer shape this module can arm is invisible to
 * `getActiveResourcesInfo()`. Counting the call is the detector that sees it.
 */
async function withTimerArmsCounted(body: () => Promise<void>): Promise<string[]> {
  const arms: string[] = [];
  const real = { setInterval: globalThis.setInterval, setTimeout: globalThis.setTimeout };
  // Generic over the timer it wraps: `setInterval` and `setTimeout` are NOT one type
  // (`@types/node` gives `setTimeout` a `__promisify__` member), so a single alias for
  // both is wrong on the `setTimeout` arm. `Parameters<F>` stays bound to the real global.
  const counted = <F extends (...args: never[]) => unknown>(fn: F, kind: string): F =>
    ((...args: Parameters<F>) => {
      arms.push(kind);
      return fn(...args);
    }) as F;
  globalThis.setInterval = counted(real.setInterval, "setInterval");
  globalThis.setTimeout = counted(real.setTimeout, "setTimeout");
  try {
    await body();
  } finally {
    globalThis.setInterval = real.setInterval;
    globalThis.setTimeout = real.setTimeout;
  }
  return arms;
}

test("realtime barrel loads with no database and no redis configured", async () => {
  // `serverEnv()` is all-or-nothing, so removing these two keys is enough to make a
  // module-scope env read throw; a module-scope `createRedisConnection()` needs REDIS_URL.
  delete process.env["DATABASE_URL"];
  delete process.env["REDIS_URL"];

  // A no-throw assertion cannot see an armed timer: `setInterval` needs no environment
  // and `--test-force-exit` removes the "the runner hangs on a live handle" backstop.
  // So the import runs under both detectors — the arm count for any timer, ref'd or not,
  // and the handle delta for a socket the module connects (`TCP*` / `TLS*`). An idle
  // `new pg.Pool()` trips neither and is NOT covered here; see the module's own comment.
  const before = timerAndConnectionCounts();
  let ns: Record<string, unknown> = {};

  const arms = await withTimerArmsCounted(async () => {
    ns = await import("../../src/realtime/index");
  });

  assert.deepEqual(
    arms,
    [],
    `importing the realtime barrel armed ${arms.join(", ")}; every timer belongs inside a ` +
      `lifecycle function, and an unref'd one is invisible to getActiveResourcesInfo()`,
  );

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
