// Runs one CI leg of a package's test files, split by measured weight.
//
// Usage, from the package directory, with the package's own test command:
//   TEST_SHARD=2/3 [TEST_DURATIONS_OUT=/abs/path.json] \
//     node ../../scripts/run-test-shard.mjs tsx --test --test-force-exit
//
// It replaces `tsx --test --test-shard=i/n "test/**/*.test.ts"`. The split rule
// is in `test-shards.mjs`. The runner appends the reporter flags and this leg's
// files to the command it is given. With `TEST_DURATIONS_OUT` set, it also writes
// each file's wall time there through `test-file-durations.mjs`, so CI records
// the next weights on every run.
//
// Every leg must get at least one file. `node --test` with NO file argument runs
// its default glob over the whole package, so an empty leg would silently run
// every file a second time. An empty leg fails instead.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  WEIGHTS_FILE,
  assignShards,
  listTestFiles,
  parseShardSpec,
  readWeights,
} from "./test-shards.mjs";

const cwd = process.cwd();

const commandLine = process.argv.slice(2);

if (commandLine.length === 0) {
  console.error("usage: node run-test-shard.mjs <test command...>   (with TEST_SHARD=i/n)");
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

const files = listTestFiles(cwd);

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

const durationsOut = process.env["TEST_DURATIONS_OUT"];

const reporterArgs =
  durationsOut === undefined || durationsOut === ""
    ? []
    : [
        "--test-reporter=spec",
        "--test-reporter-destination=stdout",
        `--test-reporter=${fileURLToPath(new URL("./test-file-durations.mjs", import.meta.url))}`,
        `--test-reporter-destination=${durationsOut}`,
      ];

const run = spawnSync(command, [...commandArgs, ...reporterArgs, ...leg.files], {
  cwd,
  stdio: "inherit",
});

if (run.error !== undefined) {
  console.error(`run-test-shard: ${command} did not start (${run.error.message})`);
  process.exit(1);
}

process.exit(run.status ?? 1);
