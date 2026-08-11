// Fails the build when a Node-only package or a Node builtin is in the browser
// bundle, or when a workspace module the bundle contains is one the source fence
// does not scan.
//
// This is ADDITIVE to `check:web-boundaries` and must stay that way. The source fence
// covers 466 files; this graph covers 425, and the 41-file difference is preview and
// debug routes under TanStack's `-`-prefixed excluded directories plus not-yet-imported
// components — code an entry-seeded graph cannot see by construction. A CI gate that
// enforced the narrower rule INSTEAD of the local check would be worse than the local
// check alone.
//
// The rules live in ./web-bundle-graph.mjs so fixtures can exercise them; this file is
// the enforcing consumer. It is deliberately NOT in the `pnpm check` chain: the graph
// pass costs 7-9 s against `pnpm check`'s 21 s, for a rule that changes only when a
// dependency or a specifier changes. CI runs it as a step in `web-unit-tests`, and this
// root script is how a developer reproduces a red CI run in one command.
//
// Usage: node scripts/check-web-bundle-graph.mjs

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { browserSurface } from "./web-boundaries.mjs";
import {
  bundleViolations,
  graphWorkspaceFiles,
  nodeOnlyPackages,
  recordBundleGraph,
} from "./web-bundle-graph.mjs";
import { webBundleGraphSelfTestFailures } from "./web-bundle-graph.selftest.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// The fixtures first, and before the 7-9 s build rather than after it. Every rule here
// is an emptiness assertion, so a rule that cannot see its own violation reports a
// clean graph exactly like a rule that works.
const selfTest = webBundleGraphSelfTestFailures();
if (selfTest.length > 0) {
  console.error("Web bundle graph self-test failed:\n");
  for (const failure of selfTest) console.error(`  ${failure}`);
  console.error("\nFix the rules before trusting this check.");
  process.exit(1);
}

const { packages: forbidden, failures: forbidFailures } = nodeOnlyPackages(ROOT);
const { files, failures: surfaceFailures } = browserSurface(ROOT);
const { graph, seconds, failures: recordFailures } = await recordBundleGraph(ROOT);

const violations = bundleViolations(graph, { forbidden, surface: new Set(files) });

// `browserSurface` is read by both halves, so its refusals arrive twice. Deduplicated
// rather than deduplicated-by-not-reporting: each failure is a reason the derived
// forbid set or the compared surface is smaller than the tree.
const failures = [...new Set([...forbidFailures, ...surfaceFailures, ...recordFailures])];

if (failures.length > 0) {
  console.error("The browser bundle check could not resolve what it rules over:");
  for (const failure of failures) console.error(`- ${failure}`);
  console.error(
    "A check that cannot resolve its own inputs must not report success. Fix these, then re-run.\n",
  );
}

if (violations.length > 0) {
  console.error(`Forbidden modules in the browser bundle (${graph.importers.size} modules):`);
  for (const violation of violations) {
    console.error(`- [${violation.rule}] ${violation.message}`);
    if (violation.chain.length > 0) {
      console.error(`    reached from: ${violation.chain.join("\n               -> ")}`);
    }
  }
  console.error("");
}

// The other direction of the surface comparison, printed and never gated. It is
// expected, benign and unstable by design: every new component is briefly a member,
// because the fence scans files the resolver has no reason to bundle yet. It is worth
// printing because nothing else in the repo would notice the source model drifting
// away from the real resolver, and the graph is already built.
const bundled = graphWorkspaceFiles(graph);
const unbundled = files.filter((file) => !bundled.has(file));
console.log(
  `Browser bundle graph: ${graph.importers.size} modules, ${bundled.size} workspace sources, recorded in ${seconds.toFixed(1)}s.`,
);
console.log(
  `The source fence scans ${files.length} files, ${unbundled.length} of which the bundle does not reach (expected: preview and debug routes, and not-yet-imported components).`,
);

if (failures.length > 0 || violations.length > 0) process.exit(1);
