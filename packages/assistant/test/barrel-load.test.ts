import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { getPath, getStringPath } from "@alfred/contracts";
import { type ImportProbeReport, parseImportProbeReport } from "./support/import-probe-report";

/**
 * **Every subpath `@alfred/assistant` advertises in its `exports` map imports inertly.**
 * Importing it reads no environment, arms no timer and opens no connection.
 *
 * The property is not about one module. A package subpath is a module-evaluation unit:
 * everything the subpath reaches is evaluated by every importer of every binding on it,
 * so an env read or a timer behind any one of them is paid for by all of them. That is
 * why this suite is driven by the `exports` map rather than by a hand-written list — **a
 * new subpath is covered by being added to `package.json`**, with no edit here.
 *
 * Each subpath is measured in its own child process (`test/support/import-probe.ts`),
 * spawned with a minimal environment (`PATH`, `HOME`, `TMPDIR` and nothing else). Two
 * reasons, both load-bearing:
 *
 * - ESM evaluates a specifier once per process. A loop over the subpaths inside this file
 *   would find subpaths 2..N already cached and all three runtime detectors would read
 *   green without measuring anything. `node:test` isolates per *file*, not per subtest.
 * - A minimal environment is stronger than deleting known keys in-process, and it does not
 *   depend on what the ambient shell holds. The `assistant-unit-tests` CI job runs with a
 *   full format-valid `serverEnv` block, so an in-process `delete DATABASE_URL` would be
 *   the only thing making the env claim mean anything there.
 *
 * Detectors, and what each one is worth:
 *
 * | Clause | Detector | Tier |
 * | --- | --- | --- |
 * | every advertised subpath is probed or explicitly declined | `classifySubpaths` refuses on any shape it has not run | 1 |
 * | reads no env at import | minimal-env child, `importError === null` | 1 |
 * | arms no timer at import, ref'd **or** unref'd | `arms` empty | 1 |
 * | opens no socket at import | `handleDelta` empty | 1 |
 * | the harness actually imported something | `names.length > 0` | 1 |
 * | `./realtime` is exactly its nine names | deep-equal against `EXPECTED_EXPORTS` | 1 |
 *
 * **What this suite does not catch.** Everything below was measured, not assumed; the
 * three escapes were confirmed green on node v22.22.3 while this probe was built.
 *
 * - A timer armed through an **imported binding** — `import { setInterval } from
 *   "node:timers"` plus `.unref()` — escapes both detectors: the arm count swaps
 *   `globalThis`, and `process.getActiveResourcesInfo()` does not report an unref'd timer.
 *   No file under any `src/` imports `node:timers` today; two use `node:timers/promises`.
 * - An arm that lands on a **macrotask tick after** the `await import(...)` continuation
 *   (`void import(...).then(() => setInterval(...))`) escapes the arm count and the handle
 *   delta even when ref'd, because the "after" snapshot is taken on that continuation.
 *   A microtask-deferred arm **is** caught.
 * - `setImmediate`: `Immediate` is not one of the watched handle kinds, and a
 *   `setImmediate`-deferred arm lands after the counters are restored.
 * - The counters are process-global, so a timer armed by `pg` or `ioredis` during the
 *   import is attributed to the subpath that pulled it in. That is deliberate — the point
 *   is what the import costs, not who inside it paid.
 * - A `new pg.Pool()` that is constructed but never connected arms no timer and opens no
 *   handle. That shape is invisible here and stays prose: construct pools inside lifecycle
 *   functions anyway.
 * - **Exported names, except `./realtime`.** The child reports names, so the name set of
 *   every other subpath is unpinned, and the per-name `typeof value === "function"` check
 *   the realtime-only predecessor made does not survive the process boundary. Locking the
 *   public API surface of all subpaths is a different property from import inertness.
 * - **Wildcard subpaths** (`./triage/*` and the eight others). A `*` matches any substring
 *   including `/`, so a wildcard's reachable set is not enumerable from the map; globbing
 *   the target directory only approximates it, at roughly 138 more children. They are
 *   declined here, by name, in the `wildcards` bucket rather than skipped silently.
 */

const PACKAGE_DIR = path.resolve(import.meta.dirname, "..");
const CHILD_PROGRAM = path.join(import.meta.dirname, "support", "import-probe.ts");

/** ~0.75 s per child measured locally; this is the "the import hung" bound, not the budget. */
const CHILD_TIMEOUT_MS = 60_000;
const CHILD_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
/** 39 children at ~0.75 s each is ~5 s here; the ceiling only has to cover a cold tsx boot. */
const SUBTEST_TIMEOUT_MS = 120_000;

/**
 * Subpaths whose exported names are pinned. Seeded with `./realtime`, whose nine names are
 * the door to the realtime module: anything wider hands a caller the relay, the reaper or
 * the `PeriodicTask` primitive, which are module-internal.
 */
const EXPECTED_EXPORTS: Readonly<Record<string, readonly string[]>> = {
  "./realtime": [
    "closeEventBridge",
    "closeReplicachePokeBridge",
    "emitReplicachePokesOverRedis",
    "getEventsSince",
    "getReplayHighWatermark",
    "initEventBridge",
    "initReplicachePokeBridge",
    "subscribeUserEvents",
    "subscribeUserPokes",
  ],
};

interface ProbedSubpath {
  readonly subpath: string;
  /** Absolute path to the subpath's target file, for the child's `import(...)`. */
  readonly file: string;
}

/**
 * Splits the package's `exports` map into what the probe runs and what it declines.
 *
 * REFUSES (throws) on any value that is not a string. A condition object, an array of
 * fallbacks or a `null` block is a shape this probe has never run, and skipping it
 * silently is the failure mode this whole suite exists to remove: every key lands in
 * `probed` or in `wildcards`, or the suite goes red.
 *
 * This deliberately does not reuse `exportTargets` from `scripts/package-exports.mjs`,
 * the repo's canonical reader. It is untyped `.mjs` under `scripts/`, which no tsconfig
 * includes, so importing it from this type-checked tree is a `TS2307`; and it answers a
 * different question — does the target exist in git — which `pnpm check:exports` already
 * owns and this suite therefore does not re-check.
 */
function classifySubpaths(exportsMap: unknown): {
  probed: readonly ProbedSubpath[];
  wildcards: readonly string[];
} {
  if (typeof exportsMap !== "object" || exportsMap === null || Array.isArray(exportsMap)) {
    throw new Error(
      `package.json "exports" is not an object of subpaths: ${JSON.stringify(exportsMap)}`,
    );
  }

  const probed: ProbedSubpath[] = [];
  const wildcards: string[] = [];
  for (const [subpath, target] of Object.entries(exportsMap)) {
    if (typeof target !== "string") {
      throw new Error(
        `exports["${subpath}"] is ${JSON.stringify(target)}, which this probe has never ` +
          `run. Teach the probe that shape — do not let a subpath go unmeasured.`,
      );
    }
    if (subpath.includes("*")) {
      wildcards.push(subpath);
      continue;
    }
    probed.push({ subpath, file: path.resolve(PACKAGE_DIR, target) });
  }
  return { probed, wildcards };
}

const execFileAsync = promisify(execFile);

/**
 * Spawns one child per subpath with a minimal environment. Rejects on a non-zero exit or a
 * timeout, and `parseImportProbeReport` rejects on anything it cannot read: every way this
 * harness can fail to measure looks exactly like "the subpath is clean", which is also the
 * true answer today, so none of them may be swallowed.
 */
async function probeImport(file: string): Promise<ImportProbeReport> {
  const minimalEnv: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR"]) {
    const value = process.env[key];
    if (value !== undefined) minimalEnv[key] = value;
  }

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(process.execPath, ["--import", "tsx", CHILD_PROGRAM, file], {
      cwd: PACKAGE_DIR,
      env: minimalEnv,
      timeout: CHILD_TIMEOUT_MS,
      maxBuffer: CHILD_OUTPUT_LIMIT_BYTES,
      encoding: "utf8",
    }));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const stderr = getStringPath(error, "stderr") ?? "";
    throw new Error(`import probe child for ${file} did not complete (${reason})\n${stderr}`);
  }

  return parseImportProbeReport(stdout.trim().split("\n").at(-1));
}

const packageManifest: unknown = JSON.parse(
  readFileSync(path.join(PACKAGE_DIR, "package.json"), "utf8"),
);
const { probed, wildcards } = classifySubpaths(getPath(packageManifest, "exports"));

describe("@alfred/assistant exports map", () => {
  it("yields subpaths to probe, and declines only wildcards", () => {
    // An empty `probed` would make the per-subpath suite below zero subtests, which
    // node:test reports as a pass. So the map having been read at all is its own clause.
    assert.ok(probed.length > 0, "no non-wildcard exports subpath was found to probe");
    assert.deepEqual(
      wildcards.filter((subpath) => !subpath.includes("*")),
      [],
      "a non-wildcard subpath was declined; every one of them must be probed",
    );
  });

  it("probes every subpath whose exported names are pinned", () => {
    // A pinned name set whose subpath was renamed or dropped would otherwise stop being
    // checked without anything going red.
    const subpaths = new Set(probed.map((entry) => entry.subpath));
    for (const pinned of Object.keys(EXPECTED_EXPORTS)) {
      assert.ok(subpaths.has(pinned), `${pinned} has a pinned name set but is not probed`);
    }
  });
});

describe("every advertised subpath imports inertly", { concurrency: 8 }, () => {
  for (const { subpath, file } of probed) {
    it(subpath, { timeout: SUBTEST_TIMEOUT_MS }, async () => {
      const report = await probeImport(file);

      assert.equal(
        report.importError,
        null,
        `importing ${subpath} with only PATH, HOME and TMPDIR set failed; a module this ` +
          `subpath reaches reads the environment at module scope`,
      );
      assert.ok(
        report.names.length > 0,
        `importing ${subpath} produced no export names, so nothing below was measured`,
      );
      assert.deepEqual(
        report.arms,
        [],
        `importing ${subpath} armed ${report.arms.join(", ")}; every timer belongs inside ` +
          `a lifecycle function, and an unref'd one is invisible to getActiveResourcesInfo()`,
      );
      assert.deepEqual(
        report.handleDelta,
        {},
        `importing ${subpath} opened ${JSON.stringify(report.handleDelta)}; every ` +
          `connection belongs inside a lifecycle function`,
      );

      const expected = EXPECTED_EXPORTS[subpath];
      if (expected !== undefined) assert.deepEqual(report.names, expected);
    });
  }
});
