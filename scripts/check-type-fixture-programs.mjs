// Fails the build when a tracked `*.type-test.ts` is read by no tsc program its
// own package's `check-types` script runs.
//
// The rules live in ./type-fixture-programs.mjs so they can be exercised by
// fixtures; this file is the enforcing consumer. It takes no flags and writes
// nothing.
//
// Usage: node scripts/check-type-fixture-programs.mjs

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { typeFixtureFailures } from "./type-fixture-programs.mjs";
import { typeFixtureProgramsSelfTestFailures } from "./type-fixture-programs.selftest.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// A check that cannot see a dead guard passes a clean tree exactly like a check
// that works. Run the fixtures first, so "no failures" means "looked and found
// nothing" rather than "looked at nothing".
const selfTest = typeFixtureProgramsSelfTestFailures();
if (selfTest.length > 0) {
  console.error("Type fixture programs self-test failed:\n");
  for (const failure of selfTest) console.error(`  ${failure}`);
  console.error("\nFix the rules before trusting this check.");
  process.exit(1);
}

const { checked, projectsProbed, failures } = typeFixtureFailures(ROOT);

if (failures.length > 0) {
  console.error("A type fixture is read by no tsc program its package type-checks:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  console.error(
    "\nA type fixture asserts nothing at runtime and no test runner executes it, so a fixture outside the checked program enforces nothing while reading as a pinned property. Widen the `include` of the project the package's `check-types` runs, add the second `tsc -p tsconfig.test.json` pass, or move the fixture into a directory that project already reads.",
  );
  process.exit(1);
}

console.log(`type fixtures clean (${checked} fixtures checked, ${projectsProbed} tsc projects probed)`);
