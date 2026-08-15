// Fails when one test file's `LIKE '<prefix>%'` cleanup can delete another test
// file's rows.
//
// DB-backed suites run as concurrent `tsx --test` child processes against ONE
// database. A prefix that is a string-prefix of another file's prefix therefore
// deletes rows that suite still needs, and the failure appears in the OTHER file
// on some runs and not others. Two such pairs existed here; one of them reddened
// `assistant-unit-tests` twice before anyone read it as a bug rather than a flake.
//
// The grammar, the rule and the `// prefix-ok: <reason>` hatch live in
// ./test-id-prefixes.mjs.
//
// Usage: node scripts/check-test-id-prefixes.mjs

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  crossFilePrefixCollisions,
  formatCollision,
  likePrefixPatterns,
  testStringLiterals,
} from "./test-id-prefixes.mjs";
import { testIdPrefixSelfTestFailures } from "./test-id-prefixes.selftest.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// A clean run of a scan that collected nothing is indistinguishable from a clean
// run of a scan that works. Drive the fixtures first, so "no prefix collides"
// means "looked and found nothing" rather than "looked at nothing".
const selfTest = testIdPrefixSelfTestFailures();
if (selfTest.length > 0) {
  console.error("test-id-prefixes self-test failed:\n");
  for (const failure of selfTest) console.error(`  ${failure}`);
  console.error("\nFix the grammar or the source discovery before trusting this check.");
  process.exit(1);
}

const { prefixes, failures, scanned } = likePrefixPatterns(ROOT);
const literals = testStringLiterals(ROOT);
const collisions = crossFilePrefixCollisions(prefixes, literals);

if (failures.length > 0) {
  console.error("The test-id-prefix scan did not resolve, so some cleanup patterns went unread:\n");
  for (const failure of failures) console.error(`  ${failure}\n`);
}

if (collisions.length > 0) {
  console.error("A test suite's cleanup pattern reaches another test file's rows:\n");
  for (const collision of collisions) console.error(`  ${formatCollision(collision)}\n`);
  console.error(
    `${collisions.length} cross-file prefix collision(s). Each one deletes rows a co-running suite still needs.`,
  );
}

if (collisions.length > 0 || failures.length > 0) process.exit(1);

// A zero count is a failure, not a pass: it means the walk found no test file or
// no cleanup pattern, and the gate compared nothing.
if (scanned === 0 || prefixes.length === 0 || literals.length === 0) {
  console.error(
    `check-test-id-prefixes scanned ${scanned} test file(s), resolved ${prefixes.length} LIKE pattern(s) ` +
      `and read ${literals.length} literal(s). A zero here means the walk is broken, not that the tree is clean.`,
  );
  process.exit(1);
}

console.log(
  `check-test-id-prefixes: ${prefixes.length} LIKE cleanup pattern(s) across ${scanned} test file(s) ` +
    `reach no other file's ${literals.length} id literal(s).`,
);
