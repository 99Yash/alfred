// Fails when a GitHub Actions `uses:` reference is not pinned by a full commit SHA.
//
// A tag such as `@v4` can move to a different commit, and the next run fetches
// whatever the tag points to then (#1879). A 40-hex commit SHA cannot move. So each
// `uses:` in a workflow or composite action names `owner/repo@<sha>`, with the
// version in a trailing comment (`# v4.4.0`), so a reader and a bump tool can see
// which release the SHA is. Local actions (`./path`) are in this repository and pass.
//
// Usage: node scripts/check-action-pins.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { listGitSourceFiles } from "./git-source-files.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const USES_LINE = /^\s*(?:-\s+)?uses:\s*(.*)$/;

const PINNED = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s+#\s*\S+/;

/** `null` when the `uses:` value is local or SHA-pinned with a version comment, else the reason. */
function pinFailure(value) {
  const ref = value.trim().replace(/^(["'])(.*)\1/, "$2");

  if (ref.startsWith("./")) return null;

  if (PINNED.test(ref)) return null;

  if (/@[0-9a-f]{40}(?:\s|$)/.test(ref)) return "SHA-pinned, but no `# <version>` comment";

  return "not pinned by a full 40-character commit SHA";
}

// A matcher that accepts everything passes a clean tree like one that works.
// Drive it on fixtures first, so "no failures" means the rule was applied.
const FIXTURES = [
  ["actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0", true],
  ["millionco/react-doctor@ced746f518f11e8283d488c4ff31c44e478bb0e5 # v2", true],
  ["github/codeql-action/init@11d5960a326750d5838078e36cf38b85af677262 # v3.1.0", true],
  ["./.github/actions/setup", true],
  ["actions/checkout@v4", false],
  ["actions/checkout@main", false],
  ["actions/checkout@11d5960a326750d5838078e36cf38b85af677262", false],
  ["actions/checkout@11d5960a32675 # v4", false],
  ["docker://redis:7-alpine", false],
];

const selfTest = FIXTURES.flatMap(([value, valid], index) =>
  (pinFailure(value) === null) === valid
    ? []
    : [`fixture ${index} should be ${valid ? "valid" : "refused"}`],
);

if (selfTest.length > 0) {
  console.error("action-pins self-test failed:\n");

  for (const failure of selfTest) console.error(`  ${failure}`);
  process.exit(1);
}

const files = listGitSourceFiles(
  [
    ".github/workflows/*.yml",
    ".github/workflows/*.yaml",
    ".github/**/action.yml",
    ".github/**/action.yaml",
  ],
  ROOT,
);

// An empty walk is a moved directory, not a clean tree.
if (files.length === 0) {
  console.error("check-action-pins: found no workflow under .github/, so it checked nothing.");
  process.exit(1);
}

let references = 0;

const failures = files.flatMap((file) =>
  readFileSync(join(ROOT, file), "utf8")
    .split(/\r?\n/)
    .flatMap((line, index) => {
      const match = USES_LINE.exec(line);

      if (!match) return [];
      references += 1;
      const reason = pinFailure(match[1]);

      return reason ? [`${file}:${index + 1}: \`${match[1].trim()}\` is ${reason}`] : [];
    }),
);

if (failures.length > 0) {
  console.error("GitHub Actions references that are not pinned:\n");

  for (const failure of failures) console.error(`- ${failure}`);
  console.error(
    "\nPin each action to the commit its tag points to, and keep the exact version as a comment:" +
      "\n  uses: actions/checkout@<40-char-sha> # v4.4.0" +
      "\nResolve the SHA with `gh api repos/<owner>/<repo>/git/ref/tags/<tag>`.",
  );
  process.exit(1);
}

console.log(
  `check-action-pins: ${references} action references in ${files.length} files are SHA-pinned.`,
);
