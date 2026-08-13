import assert from "node:assert/strict";
import test from "node:test";

/**
 * `@alfred/assistant/action-policies` is a module-evaluation unit that the API
 * dispatcher, the Replicache write path and the server lifecycle all sit on top of.
 * Two properties must hold for every one of them:
 *
 * 1. Importing the barrel reads no environment, opens no Redis connection and arms no
 *    timer. The publisher connection is built on the first `publishPolicyBust`
 *    (`resolve.ts` `getPublisher`) and the subscriber connection inside
 *    `startPolicyBustSubscriber`; neither is reached by evaluating the module. Three
 *    detectors, one per shape: the no-throw assertion catches an env read, the
 *    timer-arm count catches any `setInterval` / `setTimeout` the import schedules, and
 *    the handle delta catches a socket the import connects.
 * 2. The barrel is exactly nine runtime names, and the module's internals are not
 *    reachable at all. `packages/assistant/package.json` declares two EXACT `exports`
 *    keys for this module and no `"./action-policies/*"` wildcard, so
 *    `@alfred/assistant/action-policies/resolve` fails at the Node resolver with
 *    `ERR_PACKAGE_PATH_NOT_EXPORTED` — for every importer, wherever it lives. That is
 *    the fence; the module-architecture checker only reports the relative spelling and
 *    only from an importer that lives inside the module.
 */

/** The nine runtime exports. `ResolvedPolicy` is a type and leaves no runtime key. */
const BARREL_EXPORTS = [
  "DEFAULT_APPROVAL_NOTIFY_DELAY_MS",
  "bustPolicyCache",
  "ensureDefaultActionPolicyForUser",
  "getResolvedPolicy",
  "publishPolicyBust",
  "resolveApprovalNotifyDelayMs",
  "resolvePolicyMode",
  "startPolicyBustSubscriber",
  "stopPolicyBustSubscriber",
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
 * A handle delta cannot do this job on its own: `getActiveResourcesInfo()` does not
 * report an unref'd timer, so a module that arms one at evaluation time is invisible to
 * the handle detector. Counting the call is the detector that sees it.
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

test("action-policies barrel loads with no database and no redis configured", async () => {
  // `serverEnv()` is all-or-nothing, so removing these two keys is enough to make a
  // module-scope env read throw; a module-scope `createRedisConnection(...)` needs REDIS_URL.
  delete process.env["DATABASE_URL"]; // drift-ok: the probe needs the variable ABSENT, which no presence guard expresses
  delete process.env["REDIS_URL"]; // drift-ok: the probe needs the variable ABSENT, which no presence guard expresses

  // A no-throw assertion cannot see an armed timer or an opened socket, so the import
  // runs under both extra detectors — the arm count for any timer, ref'd or not, and the
  // handle delta for a socket the module connects (`TCP*` / `TLS*`).
  const before = timerAndConnectionCounts();
  let ns: Record<string, unknown> = {};

  const arms = await withTimerArmsCounted(async () => {
    ns = await import("@alfred/assistant/action-policies");
  });

  assert.deepEqual(
    arms,
    [],
    `importing the action-policies barrel armed ${arms.join(", ")}; the module arms no ` +
      `timer at all, and an unref'd one is invisible to getActiveResourcesInfo()`,
  );

  const after = timerAndConnectionCounts();
  for (const [kind, count] of after) {
    assert.ok(
      count <= (before.get(kind) ?? 0),
      `importing the action-policies barrel opened a new ${kind} handle; no Redis ` +
        `connection exists until the first publishPolicyBust or startPolicyBustSubscriber`,
    );
  }

  assert.deepEqual(Object.keys(ns).sort(), BARREL_EXPORTS);
  assert.equal(
    typeof ns["DEFAULT_APPROVAL_NOTIFY_DELAY_MS"],
    "number",
    "DEFAULT_APPROVAL_NOTIFY_DELAY_MS should be a number",
  );
  for (const [name, value] of Object.entries(ns)) {
    if (name === "DEFAULT_APPROVAL_NOTIFY_DELAY_MS") continue;
    assert.equal(typeof value, "function", `${name} should be a function`);
  }
});

test("the module's internals are unreachable through the package exports", async () => {
  // Held in a variable rather than written inline: the specifier is deliberately
  // unresolvable, and a literal would be a static `tsc` error rather than the runtime
  // resolver failure this test exists to commit.
  const privateSpecifier = "@alfred/assistant/action-policies/resolve";

  await assert.rejects(
    () => import(privateSpecifier),
    /ERR_PACKAGE_PATH_NOT_EXPORTED/,
    `${privateSpecifier} must die at the Node resolver. The two exports keys for this ` +
      `module are exact; adding a "./action-policies/*" wildcard would reopen every ` +
      `internal file to every importer in the repo.`,
  );
});
