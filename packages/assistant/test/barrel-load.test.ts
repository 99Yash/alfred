import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { getPath, getStringPath, toMessage } from "@alfred/contracts";
import { type ImportProbeReport, parseImportProbeReport } from "./support/import-probe-report";

/**
 * Every non-wildcard subpath in the `exports` map imports inertly: no env read, no timer, no socket.
 * Each subpath runs in its own child, because ESM caches a module once per process.
 * The child gets only `PATH`, `HOME`, `TMPDIR`, so CI's full env cannot hide a read.
 *
 * Not caught: an env read that tolerates `undefined` (`const { DATABASE_URL } = process.env`);
 * a timer from an imported `node:timers` binding; a timer armed after the import continuation
 * or by `setImmediate`; a `pg.Pool` never connected; export names of any subpath except
 * `./realtime`; wildcard subpaths.
 */

const PACKAGE_DIR = path.resolve(import.meta.dirname, "..");

const CHILD_PROGRAM = path.join(import.meta.dirname, "support", "import-probe.ts");

/** The "import hung" bound, not a budget. */
const CHILD_TIMEOUT_MS = 60_000;

/** A runaway report fails the spawn instead of reading as a truncated green. */
const CHILD_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;

/** Covers a cold tsx boot. */
const SUBTEST_TIMEOUT_MS = 120_000;

/** Pinned export names. `./realtime` must not leak the relay, the reaper, or `PeriodicTask`. */
const EXPECTED_EXPORTS = {
  "./realtime": [
    "closeEventBridge",
    "closeReplicachePokeBridge",
    "emitReplicachePokesOverRedis",
    "getEventsSince",
    "getReplayHighWatermark",
    "initEventBridge",
    "initReplicachePokeBridge",
    "registerReplicachePokeAdapter",
    "subscribeUserEvents",
    "subscribeUserPokes",
    "unregisterReplicachePokeAdapter",
  ],
} satisfies Readonly<Record<string, readonly string[]>>;

interface ProbedSubpath {
  readonly subpath: string;
  readonly file: string;
}

interface ClassifiedSubpaths {
  probed: readonly ProbedSubpath[];
  wildcards: readonly string[];
  /** Key count before classifying, so a dropped key goes red. */
  advertised: number;
}

/**
 * Split the `exports` map into probed and wildcard subpaths.
 * Throws on a non-string target, so no subpath goes unmeasured.
 * Not `exportTargets` from `scripts/package-exports.mjs`: untyped `.mjs` cannot be imported here.
 */
function classifySubpaths(exportsMap: unknown): ClassifiedSubpaths {
  if (typeof exportsMap !== "object" || exportsMap === null || Array.isArray(exportsMap)) {
    throw new Error(
      `package.json "exports" is not an object of subpaths: ${JSON.stringify(exportsMap)}`,
    );
  }

  const advertised = Object.keys(exportsMap).length;
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

  return { probed, wildcards, advertised };
}

const execFileAsync = promisify(execFile);

/** Run one child with a minimal env. Every failure throws, because a swallowed one reads as clean. */
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
    const reason = toMessage(error);
    const stderr = getStringPath(error, "stderr") ?? "";
    throw new Error(`import probe child for ${file} did not complete (${reason})\n${stderr}`);
  }

  return parseImportProbeReport(stdout.trim().split("\n").at(-1));
}

const packageManifest: unknown = JSON.parse(
  readFileSync(path.join(PACKAGE_DIR, "package.json"), "utf8"),
);

const { probed, wildcards, advertised } = classifySubpaths(getPath(packageManifest, "exports"));

describe("@alfred/assistant exports map", () => {
  it("yields subpaths to probe, and declines only wildcards", () => {
    // Zero subtests is a pass in node:test.
    assert.ok(probed.length > 0, "no non-wildcard exports subpath was found to probe");
    assert.equal(
      probed.length + wildcards.length,
      advertised,
      "a subpath in the exports map landed in neither bucket",
    );
  });

  it("probes every subpath whose exported names are pinned", () => {
    // A renamed pinned subpath would otherwise stop being checked silently.
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

      const expected = Object.entries(EXPECTED_EXPORTS).find(([p]) => p === subpath)?.[1];

      if (expected !== undefined) assert.deepEqual(report.names, expected);
    });
  }
});
