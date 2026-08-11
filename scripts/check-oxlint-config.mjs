// Fails the build when oxlint would read a config other than the root one, and
// when a root oxlint script has lost the `--config` pin that makes the root config
// the only one it reads.
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
  rootConfigFailures,
  strayOxlintConfigs,
  unpinnedLintScripts,
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

if (rootFailures.length > 0 || strays.length > 0 || unpinned.length > 0 || scripts.length === 0) {
  process.exit(1);
}
