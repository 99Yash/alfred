// Fails when a smell file breaks the catalog grammar, when a smell found in two
// PRs has no decision, or when a view that scripts/smells.mjs writes is stale.
//
// The grammar and the views live in ./smells.mjs. This file runs the self-test
// first, so a grammar that stopped reporting cannot pass the catalog.
//
// Usage: node scripts/check-smells.mjs

import { catalogState, staleViewFailures } from "./smells.mjs";
import { smellsSelfTestFailures } from "./smells.selftest.mjs";

const selfTest = smellsSelfTestFailures();

if (selfTest.length > 0) {
  console.error("smells self-test failed:\n");

  for (const failure of selfTest) console.error(`  ${failure}`);
  console.error("\nFix the grammar before trusting this check.");
  process.exit(1);
}

const { smells, failures, views } = catalogState();

failures.push(...staleViewFailures(views));

if (failures.length > 0) {
  console.error(`check-smells: ${failures.length} failure(s)\n`);

  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(`check-smells: ${smells.length} smells, every view is current.`);
