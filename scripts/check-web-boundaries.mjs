// Fails the build when browser runtime code takes a value binding on a Node-only
// workspace package, and when the prose that restates the forbidden list has
// drifted from the list itself.
//
// The rules live in ./web-boundaries.mjs so they can be exercised by fixtures;
// this file is the enforcing consumer.
//
// Usage: node scripts/check-web-boundaries.mjs

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  browserRoots,
  browserSourceFiles,
  docListFailures,
  findViolations,
} from "./web-boundaries.mjs";
import { webBoundarySelfTestFailures } from "./web-boundaries.selftest.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// A fence that cannot see its own violation passes a clean tree exactly like a
// fence that works. Check the fixtures first, so "no violations" means "looked
// and found nothing".
const selfTest = webBoundarySelfTestFailures();
if (selfTest.length > 0) {
  console.error("Web boundary self-test failed:\n");
  for (const failure of selfTest) console.error(`  ${failure}`);
  console.error("\nFix the rules before trusting this check.");
  process.exit(1);
}

const violations = [];
for (const file of browserSourceFiles(ROOT)) {
  for (const violation of findViolations(join(ROOT, file))) {
    violations.push({ file, ...violation });
  }
}

const docFailures = docListFailures(ROOT);

if (violations.length > 0) {
  console.error(`Forbidden runtime imports in ${browserRoots(ROOT).join(", ")}:`);
  for (const v of violations) {
    console.error(`- ${v.file}:${v.line} imports ${v.specifier}`);
  }
  console.error(
    "Use type-only imports where allowed, or move shared runtime code to @alfred/contracts/@alfred/sync.",
  );
}

if (docFailures.length > 0) {
  console.error("\nThe forbidden package list has drifted from the prose that restates it:");
  for (const failure of docFailures) console.error(`- ${failure}`);
  console.error(
    "Edit the marked block so it names the same packages as FORBIDDEN_RUNTIME_PACKAGES in scripts/web-boundaries.mjs.",
  );
}

if (violations.length > 0 || docFailures.length > 0) process.exit(1);
