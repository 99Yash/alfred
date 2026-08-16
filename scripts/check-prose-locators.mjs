// Fails when backticked prose names a repo-relative path or an `@alfred/*`
// specifier that resolves to nothing.
//
// Surfaces: the git-listed markdown docs an agent reads as current behavior
// (docs/reference, the four root docs, the per-workspace guides) and the
// backticked spans inside git-listed source comments under `packages/*/src` and
// `apps/*/src`. A stale locator in present-tense prose is a build failure.
//
// The rules live in ./prose-locators.mjs so fixtures can exercise them; this
// file is the enforcing consumer. It takes no flags and writes nothing.
//
// Usage: node scripts/check-prose-locators.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { listGitSourceFiles } from "./git-source-files.mjs";
import { workspaceExportIndex } from "./package-exports.mjs";
import { listWorkspaces } from "./workspaces.mjs";
import { proseLocatorFailures } from "./prose-locators.mjs";
import { proseLocatorSelfTestFailures } from "./prose-locators.selftest.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Locators that are legitimately unresolved. Every entry needs a reason — if
 * you cannot write one, the prose is wrong, not the check. Keyed by
 * `file:\`span\``, so an entry stops matching as soon as the span it exempted
 * is fixed, and the check then asks for the dead entry to be removed.
 */
const ALLOWED = new Map([
  // Environment files are created at boot and gitignored by design; the docs
  // teach where they live, not a tracked path. The committed template is
  // `.env.example` at the repo root.
  [
    "README.md:`apps/server/.env`",
    "env file created at boot, gitignored by design; the committed template is root `.env.example`",
  ],
  [
    "README.md:`apps/web/.env`",
    "env file created at boot, gitignored by design; the committed template is root `.env.example`",
  ],
  [
    "docs/reference/architecture.md:`apps/server/.env`",
    "env file created at boot, gitignored by design; the committed template is root `.env.example`",
  ],
  [
    "docs/reference/architecture.md:`apps/web/.env`",
    "env file created at boot, gitignored by design; the committed template is root `.env.example`",
  ],
  [
    "docs/reference/auth.md:`apps/server/.env`",
    "env file created at boot, gitignored by design; the committed template is root `.env.example`",
  ],
  [
    "docs/reference/database.md:`apps/server/.env`",
    "env file created at boot, gitignored by design; the committed template is root `.env.example`",
  ],
  [
    "docs/reference/user-model-gmail-projection-activation.md:`apps/server/.env`",
    "env file created at boot, gitignored by design; the committed template is root `.env.example`",
  ],
  // The prod bundle path is a build artifact (tsc emits it), not a tracked
  // source path. The same doc line lists the runnable src script above it.
  [
    "docs/reference/user-model-gmail-projection-activation.md:`apps/server/dist/scripts/backfills/project-user-model-gmail-shadow-committed.js`",
    "compiled build artifact emitted by tsc; the runnable source script is on the same doc line",
  ],
]);

// A check that cannot see a rotted locator passes a clean tree exactly like a
// check that works. Run the fixtures first, so "no failures" means "looked and
// found nothing" rather than "looked at nothing".
const selfTest = proseLocatorSelfTestFailures();
if (selfTest.length > 0) {
  console.error("Prose-locator self-test failed:\n");
  for (const failure of selfTest) console.error(`  ${failure}`);
  console.error("\nFix the rules before trusting this check.");
  process.exit(1);
}

const listed = new Set(listGitSourceFiles(["."], ROOT));
const { packages } = workspaceExportIndex(ROOT);
const { workspaces, failures: workspaceFailures } = listWorkspaces(ROOT);

const docFiles = [];
for (const file of listed) {
  if (file.startsWith("docs/reference/") && file.endsWith(".md")) docFiles.push(file);
}
for (const file of ["README.md", "CLAUDE.md", "CONTEXT.md", "docs/README.md"]) {
  if (listed.has(file)) docFiles.push(file);
}
for (const workspace of workspaces) {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const guide = `${workspace.dir}/${name}`;
    if (listed.has(guide)) {
      docFiles.push(guide);
      break;
    }
  }
}

const sourceFiles = [...listed].filter(
  (file) => /^(packages|apps)\/[^/]+\/src\//.test(file) && /\.tsx?$/.test(file),
);

const docs = docFiles.map((file) => ({ file, text: readFileSync(join(ROOT, file), "utf8") }));
const sources = sourceFiles.map((file) => ({ file, text: readFileSync(join(ROOT, file), "utf8") }));

const { failures, checked } = proseLocatorFailures({
  docs,
  sources,
  packages,
  listed,
  allowed: ALLOWED,
});

if (workspaceFailures.length > 0) {
  console.error("The workspace enumeration did not resolve, so some guides went unread:\n");
  for (const failure of workspaceFailures) console.error(`- ${failure}`);
  console.error("");
}

if (failures.length > 0) {
  console.error("Prose names locators that do not resolve:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  console.error(
    "\nRepoint each locator at the thing that owns the door now, or reword the prose" +
      "\nso it stops claiming the dead name. If a locator is genuinely external or" +
      "\nhistorical, add it to ALLOWED in scripts/check-prose-locators.mjs with a" +
      "\nreason — the reason is what keeps the list honest.",
  );
}

if (failures.length > 0 || workspaceFailures.length > 0) process.exit(1);

console.log(
  `check-prose-locators: ${docs.length} docs and ${sources.length} sources scanned, ` +
    `${checked} backticked locators resolve.`,
);
