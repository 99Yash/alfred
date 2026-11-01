// Fails when the `static-shard` matrix in `.github/workflows/ci.yml` no longer
// runs exactly the scripts `package.json` puts in `check:ci`.
//
// The matrix in ci.yml splits the `check:ci` chain across three legs, each a
// copy of the chain arranged by weight: nothing structural ties a check added
// to `package.json` to a leg in the workflow, so without this gate a new check
// would silently go unrun on CI while local `pnpm check:ci` still ran it —
// green over nothing. This check reads both sides and demands multiset
// equality:
//
//   - the LEFT side is the chain: every `&&`-separated entry in
//     `package.json`'s `check:ci`, stripped of its `pnpm ` runner prefix;
//   - the RIGHT side is the coverage: every `corepack pnpm <script>` line run
//     by one of the three `Static checks n/3` steps of the `static-shard` job.
//
// Steps OUTSIDE those names deliberately route around the guard:
// `check:static-shards` itself — this gate, named so it is never part of the
// coverage it checks — plus the PR-body check (needs a pull request to exist)
// and `check-types` (not in the `check:ci` chain) each keep their own step.
//
// Usage: node scripts/check-static-shards.mjs

import { readFileSync } from "node:fs";

const ciYmlPath = new URL("../.github/workflows/ci.yml", import.meta.url);

const pkgPath = new URL("../package.json", import.meta.url);

/** @type {Map<number, string[]>} */
const coverage = new Map();

// A "Static checks n/3" step opens its shard's coverage; any other `- name:`
// at step indent, or the end of the `static-shard` job at job-key indent,
// closes it. Step indent in this workflow is 6 spaces; top-level job keys sit
// at 2. The `corepack pnpm <script>` lines must stand alone on their line so
// the walk can read them without a YAML parser.
const STEP = /^      - name: (.+)$/;

const NAME = /Static checks (\d)\/3$/;

const JOB_KEY = /^  \S.*:$/;

const PNPM_CALL = /^corepack pnpm ([a-z][\w:-]*)$/;

let ciYml = "";

/** @type {null | { scripts?: Record<string, string> }} */
let pkg = null;

try {
  ciYml = readFileSync(ciYmlPath, "utf8");
  pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
} catch (error) {
  console.error(`error: the guard could not read its inputs — ${String(error)}`);
  process.exit(1);
}

const chainDefinition =
  pkg?.scripts?.["check:ci"]?.split(" && ").map((entry) => entry.trim().replace(/^pnpm\s+/, "")) ??
  null;

if (!chainDefinition || chainDefinition.some((entry) => entry === "")) {
  console.error(
    'error: package.json defines no "check:ci" script (or an empty &&-entry) to partition.',
  );
  process.exit(1);
}

let openShard = /** @type {number | null} */ (null);

for (const line of ciYml.split("\n")) {
  const stepName = line.match(STEP);

  if (stepName) {
    const shard = stepName[1].match(NAME);
    openShard = shard ? Number(shard[1]) : null;

    if (openShard !== null && !coverage.has(openShard)) coverage.set(openShard, []);
    continue;
  }

  if (line.match(JOB_KEY)) {
    openShard = null;
    continue;
  }

  if (openShard !== null) {
    const call = line.trim().match(PNPM_CALL);

    if (call) coverage.get(openShard)?.push(call[1]);
  }
}

openShard = null;

const shardNumbers = [...coverage.keys()].toSorted((left, right) => left - right);

if (
  shardNumbers.length !== 3 ||
  shardNumbers[0] !== 1 ||
  shardNumbers[1] !== 2 ||
  shardNumbers[2] !== 3
) {
  console.error(
    `error: expected one "Static checks 1/3".."3/3" step in ci.yml, found ${shardNumbers.length}: ${shardNumbers.join(", ") || "(none)"}.`,
  );
  console.error(
    "        The guard's coverage walk depends on those step names matching /Static checks (\\d)\\/3/ exactly.",
  );
  process.exit(1);
}

const legCoverage = shardNumbers.map((shard) => coverage.get(shard) ?? []);

if (legCoverage.some((leg) => leg.length === 0)) {
  console.error(
    "error: a Static checks step collected no `corepack pnpm <script>` line, so one leg would run nothing.",
  );
  shardNumbers.forEach((shard, index) => {
    console.error(`        Static checks ${shard}/3: ${legCoverage[index].length} script(s)`);
  });
  process.exit(1);
}

const byNameCount = (names) => {
  const counts = new Map();

  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);

  return counts;
};

const surplus = (left, right) => {
  const missing = [];

  for (const [name, count] of left) {
    const uncopied = count - (right.get(name) ?? 0);

    for (let i = 0; i < uncopied; i += 1) missing.push(name);
  }

  return missing.toSorted((a, b) => a.localeCompare(b));
};

const covered = legCoverage.flat();

const coveredCounts = byNameCount(covered);

const chainCounts = byNameCount(chainDefinition);

const sameNames =
  covered.length === chainDefinition.length &&
  [...chainCounts.entries()].every(([name, count]) => coveredCounts.get(name) === count);

// Report per-shard coverage on success and the exact diff on failure.
const shardSummary = shardNumbers
  .map((shard, index) => `  Static checks ${shard}/3: ${legCoverage[index].join(", ")}`)
  .join("\n");

if (!sameNames) {
  const missing = surplus(chainCounts, coveredCounts);
  const extras = surplus(coveredCounts, chainCounts);
  console.error(
    "error: the static-shard legs in ci.yml do not cover package.json's check:ci chain exactly.\n",
  );
  console.error(
    `check:ci declares ${chainDefinition.length} script(s):\n  ${chainDefinition.join(", ")}`,
  );
  console.error(`\ncoverage:\n${shardSummary}`);

  if (missing.length > 0)
    console.error(`\nIn check:ci but run by no leg:\n  ${missing.join("\n  ")}`);

  if (extras.length > 0)
    console.error(`\nRun by a leg but not in check:ci:\n  ${extras.join("\n  ")}`);
  console.error(
    "\nAdd the script to the same-named `Static checks` step in ci.yml, or correct whichever side is wrong.",
  );
  process.exit(1);
}

console.log(
  `check-static-shards: ${covered.length} check:ci script(s) across ${shardNumbers.length} static-shard leg(s), exactly as declared.\n${shardSummary}`,
);
