// Refreshes `packages/assistant/test/shard-weights.json` from CI runs.
//
// Usage: node scripts/test-shard-weights.mjs <ci-run-id> [<ci-run-id>...]
//
// Every `assistant-unit-tests-shard` leg uploads the CPU time of each file it ran
// (JSON lines from `test-file-cpu.mjs`) as the artifact `assistant-test-cpu-<leg>`.
// This script downloads those artifacts with `gh`, averages each file over the
// runs given, rounds each weight to 100 ms so a refresh does not rewrite every
// line, and writes the weights file. Then it prints the
// split that the new weights give for 2 to 5 legs, which is the number to read
// before you change the leg count in `.github/workflows/ci.yml`.
//
// Refresh when the legs drift apart in CI. The first log line of each
// `Assistant tests` step prints the weight of every leg. Stale weights never
// skip a file; they only make the legs uneven.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { WEIGHTS_FILE, assignShards, listTestFiles } from "./test-shards.mjs";

const PACKAGE_DIR = resolve(import.meta.dirname, "../packages/assistant");

const ARTIFACT_PATTERN = "assistant-test-cpu-*";

const runIds = process.argv.slice(2);

if (runIds.length === 0 || runIds.some((id) => !/^\d+$/.test(id))) {
  console.error("usage: node scripts/test-shard-weights.mjs <ci-run-id> [<ci-run-id>...]");
  process.exit(1);
}

const downloadDir = mkdtempSync(join(tmpdir(), "assistant-test-cpu-"));

try {
  process.exitCode = refresh(runIds, downloadDir);
} finally {
  rmSync(downloadDir, { recursive: true, force: true });
}

/**
 * @param {readonly string[]} runIds
 * @param {string} downloadDir
 * @returns {number} the exit code
 */
function refresh(runIds, downloadDir) {
  /** @type {Map<string, number[]>} */
  const samples = new Map();

  for (const runId of runIds) {
    const runDir = join(downloadDir, runId);

    const download = spawnSync(
      "gh",
      ["run", "download", runId, "--pattern", ARTIFACT_PATTERN, "--dir", runDir],
      { stdio: "inherit" },
    );

    if (download.error !== undefined || download.status !== 0) {
      console.error(`test-shard-weights: gh run download ${runId} failed; no weights were written`);

      return 1;
    }

    for (const entry of readdirSync(runDir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;

      for (const line of readFileSync(join(entry.parentPath, entry.name), "utf8").split("\n")) {
        if (line.trim() === "") continue;

        /** @type {{ file: string; ms: number }} */
        const sample = JSON.parse(line);
        const list = samples.get(sample.file) ?? [];

        list.push(sample.ms);
        samples.set(sample.file, list);
      }
    }
  }

  if (samples.size === 0) {
    console.error(
      `test-shard-weights: runs ${runIds.join(", ")} carry no ${ARTIFACT_PATTERN} data`,
    );

    return 1;
  }

  const files = listTestFiles(PACKAGE_DIR);
  const missing = files.filter((file) => !samples.has(file));

  /** @type {Map<string, number>} */
  const weights = new Map();

  for (const file of files) {
    const list = samples.get(file);

    if (list === undefined) continue;

    const mean = list.reduce((sum, ms) => sum + ms, 0) / list.length;

    weights.set(file, Math.max(100, Math.round(mean / 100) * 100));
  }

  writeFileSync(
    join(PACKAGE_DIR, WEIGHTS_FILE),
    `${JSON.stringify(Object.fromEntries(weights), null, 2)}\n`,
  );

  console.log(`wrote ${weights.size} weights to packages/assistant/${WEIGHTS_FILE}`);

  if (missing.length > 0) {
    console.log(`${missing.length} test file(s) had no measurement and will take the median:`);

    for (const file of missing) console.log(`  ${file}`);
  }

  for (const total of [2, 3, 4, 5]) {
    const { legs } = assignShards(files, weights, total);
    const seconds = legs.map((leg) => (leg.weight / 1000).toFixed(1));
    console.log(`${total} legs: ${seconds.join(" / ")} CPU-s`);
  }

  return 0;
}
