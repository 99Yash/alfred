// Fails when a repository path hardcoded inside `scripts/` stops resolving.
//
// The scripts in this directory are the repo's static gates, and several of them
// carry a path literal that names a tree they walk. When the tree moves, the walk
// collects nothing and the gate reports success over zero files — which is how
// `check-module-architecture.mjs` ran a dead rule for two campaigns. A table of
// declared paths repairs the paths it lists; this check sees the ones nobody
// declared, because it reads the scripts' own source text.
//
// The grammar and its four stated exclusions live in ./script-paths.mjs.
//
// Usage: node scripts/check-script-paths.mjs

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { repoPathLiterals, unresolvedPathLiterals } from "./script-paths.mjs";
import { scriptPathSelfTestFailures } from "./script-paths.selftest.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// A clean run of a scan that collected nothing is indistinguishable from a clean
// run of a scan that works. Check the fixtures and the live walk first, so "every
// path resolves" means "looked and found nothing broken" rather than "looked at
// nothing".
const selfTest = scriptPathSelfTestFailures();
if (selfTest.length > 0) {
  console.error("script-paths self-test failed:\n");
  for (const failure of selfTest) console.error(`  ${failure}`);
  console.error("\nFix the grammar or the source discovery before trusting this check.");
  process.exit(1);
}

const { literals, failures } = repoPathLiterals(ROOT);
const violations = unresolvedPathLiterals(literals, ROOT);

if (failures.length > 0) {
  console.error("The scripts/ path-literal scan did not resolve, so some literals went unread:\n");
  for (const failure of failures) console.error(`  ${failure}`);
  console.error("");
}

if (violations.length > 0) {
  console.error("A repository path hardcoded in scripts/ no longer resolves:\n");
  for (const violation of violations) console.error(`  ${violation}\n`);
  console.error(
    `${violations.length} unresolved path literal(s). A checker whose root is gone enforces nothing.`,
  );
}

if (violations.length > 0 || failures.length > 0) process.exit(1);

const exempt = literals.filter((entry) => entry.exempt !== null).length;
console.log(
  `check-script-paths: ${literals.length} repo-path literals in scripts/ resolve (${exempt} declared absent).`,
);
