import assert from "node:assert/strict";
import test, { mock } from "node:test";

/**
 * Importing `@alfred/assistant/action-policies` reads no env, opens no Redis, and arms no timer.
 * Its internals are unreachable: the exports map has exact keys and no wildcard.
 */

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

/** Watch only timers and sockets. Other handle kinds move on their own and flake. */
function isTimerOrConnection(kind: string): boolean {
  return kind === "Timeout" || kind.startsWith("TCP") || kind.startsWith("TLS");
}

function timerAndConnectionCounts(): Map<string, number> {
  const counts = new Map<string, number>();

  for (const kind of process.getActiveResourcesInfo()) {
    if (!isTimerOrConnection(kind)) continue;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }

  return counts;
}

/** Count timer arms, because `getActiveResourcesInfo()` does not report an unref'd timer. */
async function withTimerArmsCounted(body: () => Promise<void>): Promise<string[]> {
  // Without an implementation, `mock.method` calls the real timer and records each call.
  const intervals = mock.method(globalThis, "setInterval");
  const timeouts = mock.method(globalThis, "setTimeout");

  try {
    await body();
  } finally {
    intervals.mock.restore();
    timeouts.mock.restore();
  }

  return [
    ...intervals.mock.calls.map(() => "setInterval"),
    ...timeouts.mock.calls.map(() => "setTimeout"),
  ];
}

test("action-policies barrel loads with no database and no redis configured", async () => {
  // `serverEnv()` is all-or-nothing, so one missing key makes a module-scope read throw.
  delete process.env["DATABASE_URL"]; // drift-ok: the probe needs the variable ABSENT, which no presence guard expresses
  delete process.env["REDIS_URL"]; // drift-ok: the probe needs the variable ABSENT, which no presence guard expresses

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
  // A variable, so `tsc` does not reject the unresolvable specifier.
  const privateSpecifier = "@alfred/assistant/action-policies/resolve";

  const doorMessage =
    `${privateSpecifier} must die at the Node resolver. The two exports keys for this ` +
    `module are exact; adding a "./action-policies/*" wildcard would reopen every ` +
    `internal file to every importer in the repo.`;

  // Check `code`: the `[ERR_…]` text in the message differs across Node versions.
  await assert.rejects(
    () => import(privateSpecifier),
    (error: unknown) => {
      assert.ok(error instanceof Error, `${doorMessage} It rejected with ${String(error)}.`);
      const code: unknown = Reflect.get(error, "code");
      assert.equal(
        code,
        "ERR_PACKAGE_PATH_NOT_EXPORTED",
        `${doorMessage} Got ${String(code)}: ${error.message}`,
      );

      return true;
    },
    doorMessage,
  );
});
