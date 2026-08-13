// Guards the "define once, derive everything else" consolidations against
// re-drift. Each `gate` rule was hand-rolled in N places, collapsed to a single
// canonical helper, and would silently return the moment someone types the raw
// idiom again. jscpd (`pnpm dup`) only *reports* duplication after the fact and
// nobody runs it on every change — this runs inside `pnpm check`, so a
// reintroduced idiom fails the same gate as a type error.
//
// The rules live in ./consolidation-rules.mjs, shared with the edit-time agent
// hook (.claude/hooks/helper-hints.mjs) so the fact is stated once and cannot
// drift between the two. This file is the enforcing consumer: it runs only the
// `gate` lane. `hint` rules are advisory at edit time and never fail a build.
//
// Escape hatch: append `// drift-ok` to a line to allow a deliberate exception.
//
// Usage: node scripts/check-consolidation-drift.mjs

import { readFileSync } from "node:fs";

import { isScannedPath, matchChains, matchLine } from "./consolidation-rules.mjs";
import { selfTestFailures } from "./consolidation-rules.selftest.mjs";
import { listGitSourceFiles } from "./git-source-files.mjs";
import { gitSourceFileSelfTestFailures } from "./git-source-files.selftest.mjs";

// A clean run of a rule that cannot see its own idiom is indistinguishable from
// a clean run of a rule that works. Check the fixtures first, so "no drift"
// means "looked and found nothing" rather than "looked at nothing".
const selfTest = selfTestFailures();
for (const failure of gitSourceFileSelfTestFailures()) selfTest.push(failure);
if (selfTest.length > 0) {
  console.error("Static check self-test failed:\n");
  for (const failure of selfTest) console.error(`  ${failure}`);
  console.error("\nFix the rule or source discovery before trusting this check.");
  process.exit(1);
}

// `isScannedPath`, not `!isSkippedPath`: a rule that names its own `paths` reaches
// files the global skip filter drops (a test tree, for `db-backed-skip-hand-rolled`).
// Pre-filtering on the skip filter alone would hand such a rule zero files while its
// self-test stayed green — a check disarmed before it ever ran.
const files = listGitSourceFiles(["*.ts", "*.tsx"]).filter(isScannedPath);

const violations = [];

for (const file of files) {
  const source = readFileSync(file, "utf8");
  source.split("\n").forEach((line, i) => {
    for (const rule of matchLine(line, file, "gate")) {
      violations.push({ file, line: i + 1, text: line.trim(), fix: rule.fix });
    }
  });
  // Chain rules see the whole file: their idiom spans lines (see matchChains).
  for (const hit of matchChains(source, file, "gate")) {
    violations.push({ file, line: hit.line, text: hit.text, fix: hit.rule.fix });
  }
}

if (violations.length > 0) {
  console.error("Consolidation drift — a hand-rolled idiom re-appeared:\n");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.text}`);
    console.error(`    → ${v.fix}\n`);
  }
  console.error(
    `${violations.length} violation(s). Route through the canonical helper, or append \`// drift-ok\` if the exception is deliberate.`,
  );
  process.exit(1);
}

console.log("check-consolidation-drift: no drift.");
