/**
 * Import-inertness probe child: one process, one specifier, one JSON line on stdout.
 * `../barrel-load.test.ts` spawns it per `exports` subpath. ESM caches modules per process,
 * so a loop in one process would measure nothing after the first subpath.
 * Usage: `node --import tsx test/support/import-probe.ts <absolute specifier>`.
 * The `import type` below is erased, so nothing loads before the measurement.
 */
import type { ImportProbeReport } from "./import-probe-report";

/**
 * Timers and Redis/Postgres sockets only. The tsx loader's own file handles
 * (`FSReqPromise`, `PipeWrap`, `ConnectWrap`) change count on their own and would make the delta flaky.
 */
function isTimerOrConnection(kind: string): boolean {
  return kind === "Timeout" || kind.startsWith("TCP") || kind.startsWith("TLS");
}

/** Count each watched resource type, so a delta reads per kind. */
function timerAndConnectionCounts(): Record<string, number> {
  const counts = new Map<string, number>();

  for (const kind of process.getActiveResourcesInfo()) {
    if (!isTimerOrConnection(kind)) continue;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }

  return Object.fromEntries(counts);
}

const target = process.argv[2];

if (target === undefined || target === "") {
  process.stderr.write("import-probe: expected one argument, an absolute specifier\n");
  process.exit(2);
}

const arms: string[] = [];

// Not `t.mock.method`: this is not a `node:test` file, so the swap restores by hand in `finally`.
const real = { setInterval: globalThis.setInterval, setTimeout: globalThis.setTimeout };

// Generic because `setInterval` and `setTimeout` differ in type (`setTimeout` has `__promisify__`).
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
    // Not `toMessage`: this wants only the first line, and a workspace import would load before the measurement.
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

// Exit in the write callback: `process.exit` does not flush, so the report would truncate at the 64 KiB pipe buffer.
// Exit last anyway, so a leaked ref'd handle cannot hold the process until the driver's timeout.
process.stdout.write(`${JSON.stringify(report)}\n`, () => process.exit(0));
