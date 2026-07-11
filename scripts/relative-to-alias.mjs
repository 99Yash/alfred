// Rewrites brittle cross-tree relative import specifiers to the `~/` alias.
//
// Rule (matches the house style in apps/web): the `~/` alias is for cross-tree
// imports; same-directory (`./x`) and single-level sibling (`../x`) imports stay
// relative — they read as "local", survive a folder move, and aren't brittle.
// So we only rewrite parent climbs of depth >= 2 (`../../...`), which are the
// ones that break when a file moves between sibling subtrees.
//
// Scoped to the two roots that actually define `~/* -> ./src/*` in tsconfig
// (apps/web, apps/server). The `@alfred/*` packages are intentionally excluded:
// they emit `.d.ts` via native `tsc`, which does NOT rewrite path aliases, so a
// `~/` specifier would ship unresolvable in their published types.
//
// Usage: node scripts/relative-to-alias.mjs [--check]
//   --check  report what would change and exit non-zero if anything would; no writes.

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

const CHECK = process.argv.includes("--check");
const MIN_PARENT_DEPTH = 2;

// root: alias base dir (what `~` maps to). Every tracked ts/tsx under it is scanned.
const ROOTS = [
  { root: "apps/web/src" },
  { root: "apps/server/src" },
];

// `from "..."` and `import("...")`. Capture: lead, quote, specifier.
const specRe = /(\bfrom\s*|\bimport\s*\(\s*)(["'])((?:\.\.?\/)[^"']*)\2/g;

function toAlias(spec, fileDir, root) {
  if (!spec.startsWith("../")) return null; // only parent climbs
  const depth = (spec.match(/\.\.\//g) ?? []).length;
  if (depth < MIN_PARENT_DEPTH) return null; // keep single-level siblings
  const abs = path.resolve(fileDir, spec);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null; // escapes the alias root
  return `~/${rel.split(path.sep).join("/")}`;
}

let changedFiles = 0;
let changedSpecs = 0;
const report = [];

for (const { root } of ROOTS) {
  const files = execSync(`git ls-files '${root}/**/*.ts' '${root}/**/*.tsx'`, {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);

  for (const file of files) {
    const fileDir = path.dirname(file);
    const src = readFileSync(file, "utf8");
    let count = 0;
    const out = src.replace(specRe, (m, lead, q, spec) => {
      const alias = toAlias(spec, fileDir, root);
      if (!alias) return m;
      count++;
      report.push(`  ${file}: ${spec} -> ${alias}`);
      return `${lead}${q}${alias}${q}`;
    });
    if (count > 0) {
      if (!CHECK) writeFileSync(file, out);
      changedFiles++;
      changedSpecs += count;
    }
  }
}

console.log(`${CHECK ? "Would rewrite" : "Rewrote"} ${changedSpecs} specifiers across ${changedFiles} files:`);
for (const line of report) console.log(line);
if (CHECK && changedSpecs > 0) process.exit(1);
