// Fails the build when browser runtime code takes a value binding on a Node-only
// workspace package, and when the prose that restates the forbidden list has
// drifted from the list itself.
//
// The rules live in ./web-boundaries.mjs so they can be exercised by fixtures;
// this file is the enforcing consumer.
//
// Usage: node scripts/check-web-boundaries.mjs

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { browserSurface, docListFailures, findViolations } from "./web-boundaries.mjs";
import { webBoundarySelfTestFailures } from "./web-boundaries.selftest.mjs";
import { workspaceSelfTestFailures } from "./workspaces.selftest.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// A fence that cannot see its own violation passes a clean tree exactly like a
// fence that works. Check the fixtures first, so "no violations" means "looked
// and found nothing".
//
// The workspace enumeration is driven here too. It feeds four checks, and a vacuous
// enumeration does the most damage in this one — it silently narrows a fence, where
// the other three merely read less. One convenient host beats four copies of the
// same drive, the same way `check-consolidation-drift.mjs` hosts the git-source-file
// fixtures.
const selfTest = [...workspaceSelfTestFailures(), ...webBoundarySelfTestFailures()];
if (selfTest.length > 0) {
  console.error("Web boundary self-test failed:\n");
  for (const failure of selfTest) console.error(`  ${failure}`);
  console.error("\nFix the rules before trusting this check.");
  process.exit(1);
}

const { roots, files, failures: surfaceFailures } = browserSurface(ROOT);

const violations = [];
for (const file of files) {
  for (const violation of findViolations(ROOT, file)) {
    violations.push({ file, ...violation });
  }
}

const docFailures = docListFailures(ROOT);

if (surfaceFailures.length > 0) {
  console.error("The browser boundary scan surface did not resolve:");
  for (const failure of surfaceFailures) console.error(`- ${failure}`);
  console.error(
    "A check that cannot resolve its own surface must not report success. Fix the surface, then re-run.\n",
  );
}

if (violations.length > 0) {
  console.error(`Forbidden runtime imports in ${roots.join(", ")}:`);
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

if (surfaceFailures.length > 0 || violations.length > 0 || docFailures.length > 0) process.exit(1);
