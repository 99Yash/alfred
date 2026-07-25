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

import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";

import { isSkippedPath, matchLine } from "./consolidation-rules.mjs";

const files = execSync("git ls-files '*.ts' '*.tsx'", { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((f) => !isSkippedPath(f))
  // `git ls-files` can list a staged-but-deleted path that's gone from disk.
  .filter((f) => existsSync(f));

const violations = [];

for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const rule of matchLine(line, file, "gate")) {
      violations.push({ file, line: i + 1, text: line.trim(), fix: rule.fix });
    }
  });
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
