// Runs one CI leg of a package's test files, split by measured weight.
//
// Usage, from the package directory, with the package's own test command:
//   TEST_SHARD=2/3 [TEST_CPU_OUT=/abs/path.jsonl] \
//     node ../../scripts/run-test-shard.mjs [--exclude test/x.test.ts]... \
//       tsx --test --test-force-exit
//
// `--exclude` removes a file that another CI job runs. Keep the exclusion next to
// the script that runs the file, in the same `package.json`.
//
// It replaces `tsx --test --test-shard=i/n "test/**/*.test.ts"`. The split rule
// is in `test-shards.mjs`. The runner appends this leg's files to the command it
// is given. With `TEST_CPU_OUT` set, it also preloads `test-file-cpu.mjs`, which
// appends each file's CPU time there, so CI records the next weights on every run.
//
// Every leg must get at least one file. `node --test` with NO file argument runs
// its default glob over the whole package, so an empty leg would silently run
// every file a second time. An empty leg fails instead.

import { spawnSync } from "node:child_process";
import { availableParallelism } from "node:os";

import {
  WEIGHTS_FILE,
  assignShards,
  listTestFiles,
  parseShardSpec,
  readWeights,
} from "./test-shards.mjs";

const cwd = process.cwd();

const commandLine = process.argv.slice(2);

/** Files that another job runs; each `--exclude <path>` pair precedes the command. */
const excluded = new Set();

while (commandLine[0] === "--exclude" && commandLine.length >= 2) {
  excluded.add(commandLine[1]);
  commandLine.splice(0, 2);
}

if (commandLine.length === 0) {
  console.error(
    "usage: node run-test-shard.mjs [--exclude <test file>]... <test command...>   (with TEST_SHARD=i/n)",
  );
  process.exit(1);
}

const [command, ...commandArgs] = commandLine;

const shard = parseShardSpec(process.env["TEST_SHARD"]);

if (shard === null) {
  console.error(
    `run-test-shard: TEST_SHARD must be "i/n" with 1 <= i <= n; got ${JSON.stringify(process.env["TEST_SHARD"] ?? null)}`,
  );
  process.exit(1);
}

const listed = listTestFiles(cwd);

// An exclusion that matches no file is a renamed or deleted file. The job that
// runs it fails on the missing path too, but fail here as well: a stale
// exclusion must not read as "the other job owns it".
const unknownExclusions = [...excluded].filter((file) => !listed.includes(file));

if (unknownExclusions.length > 0) {
  console.error(
    `run-test-shard: --exclude names no test file: ${unknownExclusions.join(", ")}. ` +
      `Update the exclusion and the script that runs the file, together.`,
  );
  process.exit(1);
}

const files = listed.filter((file) => !excluded.has(file));

if (files.length === 0) {
  console.error(`run-test-shard: ${cwd}/test holds no *.test.ts file; this leg would test nothing`);
  process.exit(1);
}

const { legs, unweighted } = assignShards(files, readWeights(cwd), shard.total);

const leg = legs.at(shard.index - 1);

if (leg === undefined || leg.files.length === 0) {
  console.error(
    `run-test-shard: leg ${shard.index}/${shard.total} got no file out of ${files.length}; use fewer legs`,
  );
  process.exit(1);
}

const totalWeight = legs.reduce((sum, each) => sum + each.weight, 0);

console.log(
  `run-test-shard: leg ${shard.index}/${shard.total} runs ${leg.files.length} of ${files.length} files, ` +
    `weight ${(leg.weight / 1000).toFixed(1)} s of ${(totalWeight / 1000).toFixed(1)} s ` +
    `(legs: ${legs.map((each) => (each.weight / 1000).toFixed(1)).join(" / ")} s; ` +
    `${unweighted.length} file(s) not in ${WEIGHTS_FILE} took the median)`,
);

const cpuOut = process.env["TEST_CPU_OUT"];

// `node --test` hands its `--import` flags to every file's child, which is what
// puts the probe inside each test file's process. The env carries `TEST_CPU_OUT`.
const probeArgs =
  cpuOut === undefined || cpuOut === ""
    ? []
    : [`--import=${new URL("./test-file-cpu.mjs", import.meta.url).href}`];

// One file per core. `node --test` defaults to one fewer, to leave a core for the
// runner process, but that process only relays events. On the 4-vCPU CI runner,
// the default ran a leg at 3.0 busy cores (run 44759533677, 2026-11-20): 362
// CPU-s in 121 s.
const concurrencyArgs = [`--test-concurrency=${availableParallelism()}`];

const run = spawnSync(command, [...commandArgs, ...concurrencyArgs, ...probeArgs, ...leg.files], {
  cwd,
  stdio: "inherit",
});

if (run.error !== undefined) {
  console.error(`run-test-shard: ${command} did not start (${run.error.message})`);
  process.exit(1);
}

process.exit(run.status ?? 1);
