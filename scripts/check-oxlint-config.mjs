// Fails the build when oxlint would read a config other than the root one, when a
// root oxlint script has lost the `--config` pin that makes the root config the only
// one it reads, when a fence inside that config names a specifier that no longer
// resolves to anything, and when a gitignore line hides a tracked source file from
// oxlint's and oxfmt's file walk — a mechanism the `--config` pin is measured NOT to
// close, because the walk happens before any config is consulted.
//
// The rules live in ./oxlint-config.mjs so fixtures can exercise them; this file is
// the enforcing consumer.
//
// Usage: node scripts/check-oxlint-config.mjs

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ROOT_OXLINT_CONFIG,
  oxlintScripts,
  restrictedSpecifierFailures,
  rootConfigFailures,
  strayOxlintConfigs,
  unpinnedLintScripts,
  unwalkedSourceFailures,
} from "./oxlint-config.mjs";
import { oxlintConfigSelfTestFailures } from "./oxlint-config.selftest.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// A fence that cannot see its own violation passes a clean tree exactly like a
// fence that works, so check the fixtures first: "no stray configs" then means
// "looked and found none".
const selfTest = oxlintConfigSelfTestFailures();
if (selfTest.length > 0) {
  console.error("oxlint config self-test failed:\n");
  for (const failure of selfTest) console.error(`  ${failure}`);
  console.error("\nFix the rules before trusting this check.");
  process.exit(1);
}

const strays = strayOxlintConfigs(ROOT);
const unpinned = unpinnedLintScripts(ROOT);
const rootFailures = rootConfigFailures(ROOT);
const scripts = oxlintScripts(ROOT);

if (rootFailures.length > 0) {
  console.error("The root oxlint config did not resolve:");
  for (const failure of rootFailures) console.error(`- ${failure}`);
  console.error("");
}

if (strays.length > 0) {
  console.error("oxlint config outside the repository root:");
  for (const stray of strays) console.error(`- ${stray}`);
  console.error(
    `oxlint resolves the NEAREST config, so a config below the root REPLACES ${ROOT_OXLINT_CONFIG} for its whole subtree — every no-restricted-imports fence in it stops applying to those files, and pnpm lint still exits 0.`,
  );
  console.error(
    `Express the exemption as an entry in ${ROOT_OXLINT_CONFIG}'s "overrides" array instead, which narrows one rule for named files and leaves the rest of the config in force.\n`,
  );
}

if (scripts.length === 0) {
  console.error(
    `The root package.json declares no oxlint script, so this check would pass by reading nothing. Restore the lint script, pinned to --config ${ROOT_OXLINT_CONFIG}.\n`,
  );
}

if (unpinned.length > 0) {
  console.error(`Root oxlint script without --config ${ROOT_OXLINT_CONFIG}:`);
  for (const { script, command } of unpinned) console.error(`- ${script}: ${command}`);
  console.error(
    `Without the pin oxlint resolves the nearest config per file, so any nested config disarms the run. Add --config ${ROOT_OXLINT_CONFIG} — it replaces nested configs rather than merging with them.\n`,
  );
}

const specifiers = restrictedSpecifierFailures(ROOT);

if (specifiers.failures.length > 0) {
  console.error(`Restricted-import fence in ${ROOT_OXLINT_CONFIG} that resolves to nothing:`);
  for (const failure of specifiers.failures) console.error(`- ${failure}`);
  console.error(
    "oxlint matches a restricted specifier as text with no module resolution, so a group nobody can write produces no diagnostic, no warning and no configuration hint — it lints exactly like a fence that is simply never violated.\n",
  );
}

const unwalked = unwalkedSourceFailures(ROOT);

if (unwalked.failures.length > 0) {
  console.error("Tracked source file that oxlint and oxfmt never open:");
  for (const failure of unwalked.failures) console.error(`- ${failure}`);
  console.error(
    "Both tools walk the tree and both honor gitignore at any depth, so this is a THIRD way to disarm a fence and the --config pin above does not reach it: --no-ignore disables .eslintignore and --ignore-path rather than the gitignore walk, --ignore-path adds an ignore file instead of replacing it, and naming the hidden file on the command line does not lint it either.\n",
  );
}

// State the ungated share rather than the total, and publish what the walk rule READ
// rather than only what it rejected. A summary claiming every specifier is gated would
// recreate, in this check's own output, the false confidence it exists to remove.
console.log(
  `Restricted-import specifiers: ${specifiers.subpathChecked} gated on package and subpath, ${specifiers.checked - specifiers.subpathChecked} on package existence only (glob forms), ${specifiers.ungated} ungated (relative literals, and packages with no exports map, which nothing here can resolve).`,
);
console.log(
  `Walked source files: ${unwalked.checked} tracked or new, ${unwalked.hidden.length} removed from the walk by a gitignore rule.`,
);

if (
  rootFailures.length > 0 ||
  strays.length > 0 ||
  unpinned.length > 0 ||
  scripts.length === 0 ||
  specifiers.failures.length > 0 ||
  unwalked.failures.length > 0
) {
  process.exit(1);
}
