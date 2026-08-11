/**
 * The import-inertness probe, as a standalone child program. One process, one specifier.
 *
 * `../barrel-load.test.ts` spawns this once per advertised `exports` subpath and reads the
 * single JSON line it writes to stdout. It exports nothing: the driver never imports it,
 * it runs it. Its filename does not end in `.test.ts`, so the `test/**\/*.test.ts` glob in
 * `package.json` does not hand it to the test runner as a suite.
 *
 * One process per specifier is not a cost the driver could avoid. ESM evaluates a
 * specifier once per process, so a loop over N subpaths inside one process would find
 * subpaths 2..N already in the module cache and all three runtime detectors below would
 * read green without having measured anything.
 *
 * Usage: `node --import tsx test/support/import-probe.ts <absolute specifier>`.
 *
 * The type import is erased by TypeScript, so this process loads no validator and no
 * dependency of its own before the measurement starts.
 */
import type { ImportProbeReport } from "./import-probe-report";

/**
 * A timer is a `Timeout`; an open Redis or Postgres socket is a `TCP*` or `TLS*` handle.
 * Everything else `getActiveResourcesInfo()` reports here belongs to the tsx loader's own
 * file reads (`FSReqPromise`, `PipeWrap`, `ConnectWrap`), whose counts move on their own
 * between two calls — measured at 1 before an import, 18 immediately after and 10 one tick
 * later — and would make an unfiltered whole-set delta permanently flaky.
 */
function isTimerOrConnection(kind: string): boolean {
  return kind === "Timeout" || kind.startsWith("TCP") || kind.startsWith("TLS");
}

/** Counts each watched resource type so a delta reads as "how many more of each kind". */
function timerAndConnectionCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const kind of process.getActiveResourcesInfo()) {
    if (!isTimerOrConnection(kind)) continue;
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

const target = process.argv[2];
if (target === undefined || target === "") {
  process.stderr.write("import-probe: expected one argument, an absolute specifier\n");
  process.exit(2);
}

const arms: string[] = [];

// The house idiom for swapping a global in a test is `t.mock.method(globalThis, ...)`,
// which restores itself. This program is not a `node:test` file, so there is no `t`; the
// swap is hand-rolled with a `finally` restore on purpose. Do not "fix" it toward the idiom.
const real = { setInterval: globalThis.setInterval, setTimeout: globalThis.setTimeout };
// Generic over the timer it wraps: `setInterval` and `setTimeout` are NOT one type
// (`@types/node` gives `setTimeout` a `__promisify__` member), so a single alias for both
// is wrong on the `setTimeout` arm. `Parameters<F>` stays bound to the real global.
const counted = <F extends (...args: never[]) => unknown>(fn: F, kind: string): F =>
  ((...args: Parameters<F>) => {
    arms.push(kind);
    return fn(...args);
  }) as F;

let names: string[] = [];
let importError: string | null = null;
let before: Record<string, number> = {};
let after: Record<string, number> = {};

globalThis.setInterval = counted(real.setInterval, "setInterval");
globalThis.setTimeout = counted(real.setTimeout, "setTimeout");
try {
  before = timerAndConnectionCounts();
  try {
    const namespace: Record<string, unknown> = await import(target);
    names = Object.keys(namespace).sort();
  } catch (error) {
    importError =
      error instanceof Error ? `${error.name}: ${error.message.split("\n")[0]}` : String(error);
  }
  after = timerAndConnectionCounts();
} finally {
  globalThis.setInterval = real.setInterval;
  globalThis.setTimeout = real.setTimeout;
}

const handleDelta: Record<string, number> = {};
for (const [kind, count] of Object.entries(after)) {
  const delta = count - (before[kind] ?? 0);
  if (delta > 0) handleDelta[kind] = delta;
}

const report: ImportProbeReport = { arms, handleDelta, names, importError };
process.stdout.write(`${JSON.stringify(report)}\n`);
// Last statement on purpose: a ref'd handle the import leaked would otherwise keep this
// process alive until the driver's timeout, and a timeout is reported as a spawn failure
// rather than as the handle delta the report already carries.
process.exit(0);
