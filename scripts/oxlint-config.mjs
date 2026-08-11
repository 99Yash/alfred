// Rules about WHERE the oxlint config lives, HOW oxlint is invoked, and WHETHER
// the fences inside it still name anything.
//
// oxlint resolves the NEAREST config, not the root one. A `.oxlintrc.json`
// committed anywhere below the repo root therefore REPLACES the root config for
// that whole subtree — measured on 1.77.0: a file that is red under the root
// config lints clean once a nested `{}` sits above it, and `pnpm lint` still exits
// 0. Every `no-restricted-imports` fence in this repo rests on the root config
// being the one oxlint reads, so the disarm is silent and the symptom is a green
// run.
//
// Two mechanisms close it, and neither is redundant:
//   - the repo's oxlint invocations pin `--config <root config>`, which makes a
//     nested config wholly inert (it replaces, it does not merge — every disarm
//     shape, `{}`, an explicit `"off"`, and `ignorePatterns`, is defeated by it);
//   - the rules here report a stray config AND a lint script that lost the pin, so
//     neither the file nor the flag's removal is silent.
//
// Enforcing consumer: ../scripts/check-oxlint-config.mjs. Fixtures:
// ./oxlint-config.selftest.mjs.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { listGitSourceFiles } from "./git-source-files.mjs";

/** The one config oxlint is allowed to read, repo-relative. */
export const ROOT_OXLINT_CONFIG = ".oxlintrc.json";

/**
 * Every oxlint config file in the repository other than the root one.
 *
 * Enumeration is git-listed — tracked plus untracked-but-not-ignored — so a config
 * that exists only in a working tree is still reported, and one that is gitignored
 * is deliberately out of scope (it cannot reach CI, which sees tracked files).
 *
 * The glob is `.oxlintrc*` rather than the two names oxlint discovers today
 * (`.oxlintrc.json`, `.oxlintrc.jsonc`). The wider net is on purpose: an oxlint
 * release that starts reading `.oxlintrc.json5` or `.oxlintrc.yaml` finds those
 * names already fenced. It also treats a root config under any OTHER name as
 * stray, because `--config` pins one path and a second root file would be the
 * config nobody is reading.
 */
export function strayOxlintConfigs(root) {
  return listGitSourceFiles([":(glob)**/.oxlintrc*"], root).filter(
    (file) => file !== ROOT_OXLINT_CONFIG,
  );
}

/**
 * Every root-manifest script that invokes oxlint, with whether it pins the root
 * config.
 *
 * Script NAMES are derived from the manifest, never a literal list, so a new
 * oxlint script is covered the day it is written. A command invokes oxlint when
 * one of its whitespace-separated tokens is the binary itself, which is why
 * `oxfmt …` and `pnpm lint` are not matches.
 */
export function oxlintScripts(root) {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const scripts = manifest.scripts ?? {};
  const found = [];
  for (const [script, command] of Object.entries(scripts)) {
    if (typeof command !== "string") continue;
    const tokens = command.split(/\s+/).filter(Boolean);
    if (!tokens.some((token) => token === "oxlint" || token.endsWith("/oxlint"))) continue;
    found.push({ script, command, pinned: pinsRootConfig(tokens) });
  }
  return found;
}

/** The oxlint scripts that would resolve a nested config instead of the root one. */
export function unpinnedLintScripts(root) {
  return oxlintScripts(root)
    .filter((entry) => !entry.pinned)
    .map(({ script, command }) => ({ script, command }));
}

/**
 * The root config must exist and must say something.
 *
 * A check that reads nothing reports success, which is the failure shape this
 * whole file exists to close — so a missing, gitignored or empty root config is a
 * violation rather than an empty walk (see scripts/check-module-architecture.mjs).
 */
export function rootConfigFailures(root) {
  const listed = listGitSourceFiles([`:(glob)${ROOT_OXLINT_CONFIG}`], root);
  if (listed.length === 0) {
    return [
      `${ROOT_OXLINT_CONFIG} is missing or gitignored. Every oxlint invocation pins --config ${ROOT_OXLINT_CONFIG}, so without it the repo lints with no rules at all.`,
    ];
  }
  const source = readFileSync(resolve(root, ROOT_OXLINT_CONFIG), "utf8");
  if (source.replace(/\s+/g, "") === "" || source.replace(/\s+/g, "") === "{}") {
    return [
      `${ROOT_OXLINT_CONFIG} declares no rules. An empty root config disarms every fence in it while leaving pnpm lint green.`,
    ];
  }
  return [];
}

function pinsRootConfig(tokens) {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--config" && tokens[index + 1] === ROOT_OXLINT_CONFIG) return true;
    if (token === `--config=${ROOT_OXLINT_CONFIG}`) return true;
  }
  return false;
}
