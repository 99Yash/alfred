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
// The contents half is the same shape of silence one level in. oxlint matches a
// `no-restricted-imports` group specifier as PURE TEXT with no module resolution, so
// a group naming a specifier nobody can write is indistinguishable from a fence that
// simply never fires: no diagnostic, no warning, no configuration hint.
// `.oxlintrc.json` restricted `@alfred/api/modules/knowledge/internal` for two whole
// campaigns after the file behind it was deleted, and oxlint, `pnpm lint`,
// `pnpm check` and CI's `static` job all stayed green. The rules below make a
// specifier that stops resolving fail by name.
//
// Enforcing consumer: ../scripts/check-oxlint-config.mjs. Fixtures:
// ./oxlint-config.selftest.mjs.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { listGitSourceFiles } from "./git-source-files.mjs";
import { exportTargets, matchesSubpathKey } from "./package-exports.mjs";
import { listWorkspaces } from "./workspaces.mjs";

/** The one config oxlint is allowed to read, repo-relative. */
export const ROOT_OXLINT_CONFIG = ".oxlintrc.json";

const RESTRICTED_IMPORTS = "no-restricted-imports";

// The TOOL comes from this repo's own install; only the config and the workspaces
// come from the `root` argument. That split is what lets a fixture root be a bare
// `mkdtemp` with no `node_modules` and still be read by the same oxlint the repo
// lints with. Measured: `--print-config` in such a directory exits 0 in ~82 ms.
const OXLINT_BIN = resolve(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "node_modules/.bin/oxlint",
);

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

/**
 * The root config as oxlint itself resolved it, or why it could not be read.
 *
 * The reader is `oxlint --print-config`, not a JSON parse of the file: the tracked
 * config is JSONC (`JSON.parse` throws on its `//` comments), and a regex
 * comment-stripper would corrupt a `message` string the day a fence message cites a
 * URL. Reading what oxlint resolved is also the stronger claim for a gate whose
 * subject is what oxlint enforces — `overrides` arrive already merged into the shape
 * the linter acts on.
 *
 * Every way this can fail returns a `failure` rather than an empty config, because a
 * config that read as empty is exactly the silence this file exists to end.
 */
export function resolvedOxlintConfig(root) {
  const invocation = `oxlint --print-config --config ${ROOT_OXLINT_CONFIG}`;
  let stdout;
  try {
    stdout = execFileSync(OXLINT_BIN, ["--print-config", "--config", ROOT_OXLINT_CONFIG], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return {
      failure: `\`${invocation}\` did not run (${error.message}). The restricted-specifier rules read the config through oxlint, so without it they would examine nothing.`,
    };
  }

  let config;
  try {
    config = JSON.parse(stdout);
  } catch (error) {
    return {
      failure: `\`${invocation}\` did not emit JSON (${error.message}). Its resolved shape is an internal representation, not a documented contract, so a release that changes it must fail this check rather than silently read nothing.`,
    };
  }
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return {
      failure: `\`${invocation}\` emitted ${JSON.stringify(config)} rather than a config object, so no rule site could be located.`,
    };
  }
  return { config };
}

/**
 * Every rule site in a resolved config that carries `no-restricted-imports`.
 *
 * A site is the root `rules` object or one `overrides` entry, named by `where` so a
 * failure can say which one. `overrides` must be walked: three of this repo's four
 * sites live there, and a rule's options in an override REPLACE the root's wholesale
 * rather than merging, so an override is an independent fence with its own dead-
 * specifier risk.
 *
 * The resolved rule value is `unknown` and is validated here, at the boundary that
 * owns it. A shape this reader does not recognize is a `failure`, never a skip — a
 * site quietly contributing zero groups is the failure mode one level up from the
 * one being fixed. A severity-only string (`"allow"`, `"deny"`) is recognized and
 * contributes no groups, which is what the repo's own `"off"` override resolves to.
 *
 * Exported for item 47, which compares the group ARRAYS across these same sites and
 * must not re-derive the reader.
 */
export function restrictedImportSites(config) {
  const sites = [];
  const failures = [];

  collectSite(config.rules, "rules", sites, failures);

  const overrides = config.overrides;
  if (overrides !== undefined) {
    if (!Array.isArray(overrides)) {
      failures.push(
        `the resolved config's "overrides" is ${JSON.stringify(overrides)} rather than an array, so any fence inside it went unread.`,
      );
    } else {
      for (const [index, override] of overrides.entries()) {
        const where = `overrides[${index}]`;
        if (override === null || typeof override !== "object" || Array.isArray(override)) {
          failures.push(
            `${where} is ${JSON.stringify(override)} rather than an object, so any fence inside it went unread.`,
          );
          continue;
        }
        collectSite(override.rules, where, sites, failures);
      }
    }
  }

  return { sites, failures };
}

/**
 * Every `no-restricted-imports` group specifier that names a workspace package must
 * still name one, and a glob-free one must name a subpath that package publishes.
 *
 * Three kinds of specifier, three honest tiers — a rule requiring every specifier to
 * resolve would report correct fences as dead:
 *
 *   - a glob-free specifier naming a workspace package is gated on BOTH halves: the
 *     package exists, and its `exports` map publishes the subpath (an explicit key or
 *     a `*` key that matches). This is the class that rotted for two campaigns.
 *     When the key that publishes it is a WILDCARD, the file behind it is gated too:
 *     `"./knowledge/*"` keeps publishing the whole family after the one module the
 *     fence names is deleted, so the family-level answer is the same before and after
 *     — which is the failure being fixed, one level in. `pnpm check:exports` cannot
 *     cover this: it asks whether a wildcard target matches SOME file, and dozens
 *     match. An explicit key's target IS its subject, so that half is left to it
 *     rather than reported twice;
 *   - a specifier holding a glob is gated on package existence ONLY. A defensive
 *     pattern legitimately covers subpaths nobody has written yet — `@alfred/http`'s
 *     map publishes exactly `"."`, so `@alfred/http/*` resolves through no entry and
 *     is still correct. Deleting the package still reddens it;
 *   - a relative literal (`.`, `../..`, `./index*`) is UNGATED and counted. It has no
 *     single resolution: `../..` from the deepest file the fence covers points at a
 *     directory with no index, so a must-resolve rule would reject a pattern whose
 *     whole purpose is to cover a depth that does not exist yet.
 *
 * A bare specifier whose leading segments name no workspace package at all is the
 * refusal branch. It is the same branch as "the package was deleted", and it also
 * fails closed on a future external fence (`lodash`, `node:fs`) instead of ignoring
 * it. It has nothing to write on this tree, which is the point: a refusal that
 * fires on a healthy repo would have been tuned away.
 */
export function restrictedSpecifierFailures(root) {
  const failures = [];

  const resolved = resolvedOxlintConfig(root);
  if (resolved.failure !== undefined) {
    return { checked: 0, subpathChecked: 0, ungated: 0, failures: [resolved.failure] };
  }

  const { sites, failures: readerFailures } = restrictedImportSites(resolved.config);
  failures.push(...readerFailures);

  const { packages, listed, failures: workspaceFailures } = workspaceExportIndex(root);
  failures.push(...workspaceFailures);
  if (packages.size === 0) {
    failures.push(
      "no workspace package declares a name, so no restricted-import specifier could be resolved against one.",
    );
    return { checked: 0, subpathChecked: 0, ungated: 0, failures };
  }

  let checked = 0;
  let subpathChecked = 0;
  let ungated = 0;

  for (const { where, groups } of sites) {
    for (const { group } of groups) {
      for (const specifier of group) {
        const classified = specifierKind(specifier);
        if (classified.kind === "relative") {
          ungated += 1;
          continue;
        }

        const { packageName, subpath } = classified;

        if (packageName.includes("*")) {
          checked += 1;
          const named = [...packages.keys()].some((name) => matchesSubpathKey(packageName, name));
          if (!named) {
            failures.push(
              `${where} · "${specifier}" restricts a package pattern that matches no workspace package. Either a package it covered was deleted or renamed, or the fence never named one — a group nobody can write is indistinguishable from a live fence in a green lint run.`,
            );
          }
          continue;
        }

        const entry = packages.get(packageName);
        if (entry === undefined) {
          checked += 1;
          failures.push(
            `${where} · "${specifier}" restricts "${packageName}", which no workspace package declares. Delete the group, or repoint it at the package that owns the door now — oxlint matches this string as text, so it fences nothing and reports nothing.`,
          );
          continue;
        }

        if (subpath.includes("*")) {
          checked += 1;
          continue;
        }

        if (entry.problem !== null) {
          ungated += 1;
          continue;
        }

        checked += 1;
        subpathChecked += 1;
        const key = publishedKey(entry.keys, subpath);
        if (key === null) {
          failures.push(
            `${where} · "${specifier}" restricts a subpath "${subpath}" that ${packageName}'s exports map does not publish, so no importer can write it and the fence is dead. Repoint the group at the subpath that carries the door now, or delete it.`,
          );
          continue;
        }

        const published = entry.keys.get(key);
        if (published.blocked) {
          failures.push(
            `${where} · "${specifier}" restricts a subpath ${packageName}'s exports map SEALS ("${key}" maps to null), so the fence duplicates a block that already refuses every importer. Delete the group; the null entry is the enforcement.`,
          );
          continue;
        }

        if (!key.includes("*")) continue;

        const resolvedPaths = published.targets.map((target) =>
          wildcardTargetPath(entry.dir, key, target, subpath),
        );
        if (!resolvedPaths.some((path) => path !== null && listed.has(path))) {
          failures.push(
            `${where} · "${specifier}" resolves through ${packageName}'s wildcard exports key "${key}" to ${resolvedPaths.map((path) => `"${path}"`).join(" / ")}, which no file git lists. The wildcard still publishes the family, so nothing else reports this: the module the fence names is gone and the fence now restricts a specifier nobody can write.`,
          );
        }
      }
    }
  }

  if (checked === 0) {
    failures.push(
      `no ${RESTRICTED_IMPORTS} group specifier was resolved against a workspace package (0 gated, ${ungated} ungated, across ${sites.length} rule site(s)), so this check examined nothing. A green run over an empty read is exactly what let a dead fence survive two campaigns.`,
    );
  }

  return { checked, subpathChecked, ungated, failures };
}

/**
 * One rule site's groups, or a refusal describing the shape that was not read.
 *
 * `paths` is the rule's other form and carries no group patterns, so an options
 * object without `patterns` contributes nothing and is not a refusal. A `patterns`
 * ENTRY without a `group` key is a refusal: it is either the `regex` form or a
 * malformed fence, and both would otherwise pass as zero specifiers.
 */
function collectSite(rules, where, sites, failures) {
  if (rules === undefined) return;
  if (rules === null || typeof rules !== "object" || Array.isArray(rules)) {
    failures.push(
      `${where}.rules is ${JSON.stringify(rules)} rather than an object of rule names, so any fence inside it went unread.`,
    );
    return;
  }
  if (!(RESTRICTED_IMPORTS in rules)) return;

  const value = rules[RESTRICTED_IMPORTS];
  if (typeof value === "string") {
    sites.push({ where, groups: [] });
    return;
  }
  if (!Array.isArray(value) || value.length === 0 || typeof value[0] !== "string") {
    failures.push(
      `${where}'s ${RESTRICTED_IMPORTS} resolved to ${JSON.stringify(value)}, which is neither a severity string nor a [severity, options] array. This reader cannot tell an armed fence from a disarmed one in that shape, so it refuses instead of reporting zero groups.`,
    );
    return;
  }

  // oxlint resolves the rule to `["deny", [ {patterns: …} ]]` — the options sit in a
  // nested array, one level deeper than the `["error", {patterns: …}]` form written in
  // the config. Both nestings are accepted because the nesting is the internal detail
  // most likely to move in a release, while a non-object leaf stays a refusal.
  const groups = [];
  for (const options of value.slice(1).flat()) {
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      failures.push(
        `${where}'s ${RESTRICTED_IMPORTS} carries an options element ${JSON.stringify(options)} that is neither an object nor an array of them, so its fences went unread.`,
      );
      continue;
    }
    const patterns = options.patterns;
    if (patterns === undefined) continue;
    if (!Array.isArray(patterns)) {
      failures.push(
        `${where}'s ${RESTRICTED_IMPORTS} "patterns" is ${JSON.stringify(patterns)} rather than an array, so its fences went unread.`,
      );
      continue;
    }
    for (const [index, pattern] of patterns.entries()) {
      if (typeof pattern === "string") {
        groups.push({ group: [pattern], message: null });
        continue;
      }
      if (pattern === null || typeof pattern !== "object" || Array.isArray(pattern)) {
        failures.push(
          `${where}'s ${RESTRICTED_IMPORTS} patterns[${index}] is ${JSON.stringify(pattern)}, which is neither a specifier string nor a group object.`,
        );
        continue;
      }
      const group = pattern.group;
      if (!Array.isArray(group) || !group.every((entry) => typeof entry === "string")) {
        failures.push(
          `${where}'s ${RESTRICTED_IMPORTS} patterns[${index}] has no "group" array of specifier strings (received ${JSON.stringify(group)}), so nothing in it could be resolved.`,
        );
        continue;
      }
      groups.push({ group, message: typeof pattern.message === "string" ? pattern.message : null });
    }
  }

  sites.push({ where, groups });
}

/**
 * Split a bare specifier into the package it names and the subpath under it.
 *
 * A leading `.` is the whole test for a relative literal — oxlint's own patterns are
 * matched against the specifier as written, so a relative one never names a package.
 * A scoped name is two segments, an unscoped name is one, and the remainder becomes
 * an `exports`-map subpath (`"."` when there is none) so it can be compared with the
 * keys a manifest publishes without a second spelling.
 */
function specifierKind(specifier) {
  if (specifier.startsWith(".")) return { kind: "relative" };

  const segments = specifier.split("/");
  const scoped = specifier.startsWith("@");
  const packageName = scoped ? segments.slice(0, 2).join("/") : segments[0];
  const rest = segments.slice(scoped ? 2 : 1).join("/");

  return { kind: "bare", packageName, subpath: rest === "" ? "." : `./${rest}` };
}

/**
 * Which `exports` key publishes one subpath, or `null` when none does.
 *
 * An exact key wins, then the matching `*` key with the longest text before its star
 * — Node's own specificity order, which matters because a sealed `"./sealed": null`
 * sits beside a `"./*"` that would otherwise match it.
 */
function publishedKey(keys, subpath) {
  if (keys.has(subpath)) return subpath;
  let best = null;
  for (const key of keys.keys()) {
    if (!key.includes("*")) continue;
    if (!matchesSubpathKey(key, subpath)) continue;
    if (best === null || key.indexOf("*") > best.indexOf("*")) best = key;
  }
  return best;
}

/**
 * The concrete file a wildcard `exports` key resolves one subpath to, or `null` when
 * the target escapes its package.
 *
 * The text the key's `*` stood for is substituted into the target's `*`, which is
 * Node's own rule. A key with a `*` whose target has none maps its whole family onto
 * one file, so the target is used as written.
 */
function wildcardTargetPath(packageDir, key, target, subpath) {
  if (!target.startsWith("./")) return null;

  const star = key.indexOf("*");
  const matched = subpath.slice(star, subpath.length - (key.length - star - 1));
  const path = `${packageDir}/${target.replace("*", matched).slice(2)}`;
  return path.split("/").includes("..") ? null : path;
}

/**
 * Every named workspace package, with the `exports` keys it publishes, plus one
 * listing of every file inside the workspaces.
 *
 * The listing is taken ONCE rather than per target: a `git ls-files` whose pathspec
 * parent is gone writes `warning: could not open directory …` onto this check's own
 * stderr, and a gate whose failure output opens with a raw git warning reads like a
 * crash.
 *
 * A key carries `blocked` when every entry under it is `null`, so a caller can tell a
 * sealed door from a published one, and the targets behind it so a wildcard key can
 * be resolved to a file. `problem` is non-null when the subpath half cannot be
 * asserted at all: a package with no `exports` map resolves `.` through `main`, and a
 * map that does not parse is `pnpm check:exports`'s failure, not a licence for this
 * check to report every subpath under it as dead.
 */
function workspaceExportIndex(root) {
  const { workspaces, globs, failures } = listWorkspaces(root);
  const packages = new Map();
  const listed = new Set(globs.length === 0 ? [] : listGitSourceFiles(globs, root));

  for (const { name, dir, manifest } of workspaces) {
    if (name === null) continue;

    let parsed;
    try {
      parsed = JSON.parse(readFileSync(resolve(root, manifest), "utf8"));
    } catch {
      packages.set(name, { dir, keys: new Map(), problem: `${manifest} does not parse` });
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || !("exports" in parsed)) {
      packages.set(name, { dir, keys: new Map(), problem: `${name} declares no exports map` });
      continue;
    }

    const { targets, failures: shapeFailures } = exportTargets(parsed.exports);
    if (shapeFailures.length > 0) {
      packages.set(name, {
        dir,
        keys: new Map(),
        problem: `${name}'s exports map does not parse (pnpm check:exports reports it)`,
      });
      continue;
    }

    const keys = new Map();
    for (const { subpath, target, kind } of targets) {
      const seen = keys.get(subpath) ?? { blocked: true, targets: [] };
      if (kind === "blocked") keys.set(subpath, seen);
      else keys.set(subpath, { blocked: false, targets: [...seen.targets, target] });
    }
    packages.set(name, { dir, keys, problem: null });
  }

  return { packages, listed, failures };
}

function pinsRootConfig(tokens) {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--config" && tokens[index + 1] === ROOT_OXLINT_CONFIG) return true;
    if (token === `--config=${ROOT_OXLINT_CONFIG}`) return true;
  }
  return false;
}
