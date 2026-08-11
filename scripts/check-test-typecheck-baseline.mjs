// Fails the build when a package's second-pass `exclude` stops describing which
// of its test files are actually dirty.
//
// The rules live in ./test-typecheck-baseline.mjs so they can be exercised by
// fixtures; this file is the enforcing consumer. It takes no flags and writes
// nothing.
//
// Usage: node scripts/check-test-typecheck-baseline.mjs

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { checkTestTypecheckBaseline, defaultTscBinary } from "./test-typecheck-baseline.mjs";
import { testTypecheckBaselineSelfTestFailures } from "./test-typecheck-baseline.selftest.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// A check that cannot see drift passes a clean tree exactly like a check that
// works. Run the fixtures first, so "no drift" means "looked and found nothing"
// rather than "looked at nothing".
const selfTest = testTypecheckBaselineSelfTestFailures();
if (selfTest.length > 0) {
  console.error("Test typecheck baseline self-test failed:\n");
  for (const failure of selfTest) console.error(`  ${failure}`);
  console.error("\nFix the rules before trusting this check.");
  process.exit(1);
}

const result = checkTestTypecheckBaseline({ root: ROOT, tscBinary: defaultTscBinary(ROOT) });

if (!result.ok) {
  console.error("A test typecheck baseline no longer describes its tree:\n");

  for (const file of result.nowClean) {
    console.error(`- ${file} · is excluded but now type-checks cleanly. Delete the entry.`);
  }
  for (const file of result.newlyDirty) {
    console.error(
      `- ${file} · has a type error and is not excluded. Repair it, or add a literal entry and say in the PR why the debt is being taken on.`,
    );
  }
  for (const entry of result.missing) {
    console.error(`- ${entry}. Delete the entry.`);
  }
  for (const problem of result.problems) {
    console.error(`- ${problem}.`);
  }

  console.error(
    "\nAn `exclude` in a `tsconfig.test.json` is a baseline of existing debt, not a policy: it is the list of files that were already broken when the tree entered the program. An entry that outlives its error, or a broken file with no entry, both turn the list into a place type errors can hide. Run `pnpm --filter <package> check-types` after editing it.",
  );
  process.exit(1);
}

const baselined = result.packages.filter((entry) => entry.excluded > 0);
const total = baselined.reduce((sum, entry) => sum + entry.excluded, 0);
console.log(
  baselined.length === 0
    ? `test typecheck baselines clean (${result.packages.length} test projects, none baselines a file)`
    : `test typecheck baselines clean (${result.packages.length} test projects, ${total} baselined file(s): ${baselined
        .map((entry) => `${entry.name} ${entry.excluded}`)
        .join(", ")})`,
);
