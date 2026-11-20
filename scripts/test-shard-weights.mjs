// Refreshes `packages/assistant/test/shard-weights.json` from one CI run.
//
// Usage: node scripts/test-shard-weights.mjs <ci-run-id>
//
// Every `assistant-unit-tests-shard` leg uploads the wall time of each file it ran
// as the artifact `assistant-test-durations-<leg>`. This script downloads those
// artifacts with `gh`, merges them, rounds each weight to 100 ms so a refresh
// does not rewrite every line, and writes the weights file. Then it prints the
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

const ARTIFACT_PATTERN = "assistant-test-durations-*";

const runId = process.argv.at(2);

if (runId === undefined || !/^\d+$/.test(runId)) {
  console.error("usage: node scripts/test-shard-weights.mjs <ci-run-id>");
  process.exit(1);
}

const downloadDir = mkdtempSync(join(tmpdir(), "assistant-test-durations-"));

try {
  process.exitCode = refresh(runId, downloadDir);
} finally {
  rmSync(downloadDir, { recursive: true, force: true });
}

/**
 * @param {string} runId
 * @param {string} downloadDir
 * @returns {number} the exit code
 */
function refresh(runId, downloadDir) {
  const download = spawnSync(
    "gh",
    ["run", "download", runId, "--pattern", ARTIFACT_PATTERN, "--dir", downloadDir],
    { stdio: "inherit" },
  );

  if (download.error !== undefined || download.status !== 0) {
    console.error(`test-shard-weights: gh run download ${runId} failed; no weights were written`);

    return 1;
  }

  /** @type {Map<string, number>} */
  const measured = new Map();

  for (const entry of readdirSync(downloadDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    /** @type {Record<string, number>} */
    const durations = JSON.parse(readFileSync(join(entry.parentPath, entry.name), "utf8"));

    for (const [file, ms] of Object.entries(durations)) {
      measured.set(file, Math.max(measured.get(file) ?? 0, ms));
    }
  }

  const files = listTestFiles(PACKAGE_DIR);
  const missing = files.filter((file) => !measured.has(file));

  if (measured.size === 0) {
    console.error(`test-shard-weights: run ${runId} carries no ${ARTIFACT_PATTERN} data`);

    return 1;
  }

  /** @type {Map<string, number>} */
  const weights = new Map();

  for (const file of files) {
    const ms = measured.get(file);

    if (ms !== undefined) weights.set(file, Math.max(100, Math.round(ms / 100) * 100));
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
    console.log(`${total} legs: ${seconds.join(" / ")} s of summed file wall time`);
  }

  return 0;
}
