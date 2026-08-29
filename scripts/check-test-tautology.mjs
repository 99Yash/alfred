// Guards against tautological tests — asserts that restate implementation
// instead of pinning a product/state/contract property.
//
// Runs the `gate` lane of `test-tautology-rules.mjs` under `pnpm check`.
// `hint` rules are advisory at edit time and never fail the build.
// Escape hatch: `// tautology-ok: <reason>` (see rules file for scope).
//
// Usage: node scripts/check-test-tautology.mjs

import { readFileSync } from "node:fs";

import { isScannedPath, matchChains, matchLine } from "./test-tautology-rules.mjs";
import { listGitSourceFiles } from "./git-source-files.mjs";

const files = listGitSourceFiles(["*.test.ts", "*.test.tsx"]).filter(isScannedPath);

const violations = [];

for (const file of files) {
  const source = readFileSync(file, "utf8");
  source.split("\n").forEach((line, i) => {
    for (const rule of matchLine(line, file, "gate")) {
      violations.push({ file, line: i + 1, text: line.trim(), fix: rule.fix, id: rule.id });
    }
  });
  for (const hit of matchChains(source, file, "gate")) {
    violations.push({ file, line: hit.line, text: hit.text, fix: hit.rule.fix, id: hit.rule.id });
  }
}

if (violations.length > 0) {
  console.error("Tautological tests — a test restates implementation:\n");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} [${v.id}]`);
    console.error(`    ${v.text}`);
    console.error(`    → ${v.fix}\n`);
  }
  console.error(
    `${violations.length} violation(s). Fix the test to assert a product/state/contract property, or append \`// tautology-ok: <reason>\` if the tautology is load-bearing (cross-check + literal anchor, policy pin).`,
  );
  process.exit(1);
}

console.log("check-test-tautology: no tautological tests.");
