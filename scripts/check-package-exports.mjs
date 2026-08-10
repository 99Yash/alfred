// Fails the build when a workspace advertises an `exports` subpath whose target
// resolves to no file git lists.
//
// The rules live in ./package-exports.mjs so they can be exercised by fixtures;
// this file is the enforcing consumer. It takes no flags and writes nothing.
//
// Usage: node scripts/check-package-exports.mjs

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { packageExportsFailures } from "./package-exports.mjs";
import { packageExportsSelfTestFailures } from "./package-exports.selftest.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// A check that cannot see a rotted entry passes a clean tree exactly like a check
// that works. Run the fixtures first, so "no failures" means "looked and found
// nothing" rather than "looked at nothing".
const selfTest = packageExportsSelfTestFailures();
if (selfTest.length > 0) {
  console.error("Package exports self-test failed:\n");
  for (const failure of selfTest) console.error(`  ${failure}`);
  console.error("\nFix the rules before trusting this check.");
  process.exit(1);
}

const { checked, blocked, failures } = packageExportsFailures(ROOT);

if (failures.length > 0) {
  console.error("A workspace advertises an exports subpath that resolves to nothing:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  console.error(
    "\nDelete the entry, or repoint it at the file that replaced its target. A package's exports map is its own statement of its public doors, and nothing else re-derives it.",
  );
  process.exit(1);
}

console.log(`package exports clean (${checked} targets checked, ${blocked} deliberately blocked)`);
