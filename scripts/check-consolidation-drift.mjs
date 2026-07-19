// Guards the "define once, derive everything else" consolidations against
// re-drift. Each pattern below was hand-rolled in N places, collapsed to a
// single canonical helper, and would silently return the moment someone types
// the raw idiom again. jscpd (`pnpm dup`) only *reports* duplication after the
// fact and nobody runs it on every change — this runs inside `pnpm check`, so
// a reintroduced idiom fails the same gate as a type error.
//
// Scope is deliberately narrow: only primitives that are *fully* consolidated
// to one owner (so a match is unambiguously drift, not un-migrated legacy).
// The error/`toMessage` idiom is intentionally NOT here — it still has ~95
// un-migrated call sites, so banning it would gate on a migration, not drift.
//
// Escape hatch: append `// drift-ok` to a line to allow a deliberate exception.
//
// Usage: node scripts/check-consolidation-drift.mjs

import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";

// Files that OWN a canonical helper legitimately contain its definition/doc.
const OWNER_FILES = new Set([
  "packages/contracts/src/guards.ts", // toStringArray (+ its doc-comment example)
  "packages/contracts/src/tool-schemas.ts", // canonicalParamKey
]);

// path predicate → skip. Tests/evals/scripts/backfills legitimately use casts
// for fixture ergonomics; generated + built output isn't source.
const isSkipped = (f) =>
  /(^|\/)(dist|build|coverage|node_modules)\//.test(f) ||
  /\.(d|gen)\.ts$/.test(f) ||
  /\.test\.tsx?$/.test(f) ||
  /(^|\/)(test|__mocks__|evals)\//.test(f) ||
  f.endsWith(".eval.ts") ||
  /(^|\/)scripts\//.test(f);

const RULES = [
  {
    // `x as string[]` — the unchecked element-type assertion. `as string[] | ...`
    // (a union) is a different, narrower shape and is left alone.
    re: /\bas\s+string\[\](?!\s*[|&])/,
    fix: "Use toStringArray(x) from @alfred/contracts — it checks the element type at runtime instead of asserting it.",
  },
  {
    // The `.toLowerCase().replace(/[_-]/g, "")` key-canonicalization idiom.
    re: /\.toLowerCase\(\)\.replace\(\s*\/\[_-\]\/g\s*,\s*""\s*\)/,
    fix: "Use canonicalParamKey(key) from @alfred/contracts — the one canonical key-folding function.",
  },
];

const files = execSync("git ls-files '*.ts' '*.tsx'", { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((f) => !isSkipped(f) && !OWNER_FILES.has(f))
  // `git ls-files` can list a staged-but-deleted path that's gone from disk.
  .filter((f) => existsSync(f));

const violations = [];

for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (line.includes("// drift-ok")) return;
    // Skip whole-line comments — doc examples of the banned idiom are not drift.
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
    for (const rule of RULES) {
      if (rule.re.test(line)) {
        violations.push({ file, line: i + 1, text: line.trim(), fix: rule.fix });
      }
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
