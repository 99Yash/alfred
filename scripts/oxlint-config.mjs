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
// A THIRD mechanism shrinks the same fence, and the pin above is measured NOT to
// close it: the FILE WALK. oxlint and oxfmt both honor `.gitignore`, at any depth, so
// a gitignore line naming an already-tracked source file removes it from the walk
// while leaving it tracked — it still ships, still compiles, still runs in CI, and no
// rule can fire on a file the linter never opens. Measured on 1.77.0 / oxfmt 0.26.0,
// and the reason it needs its own rule rather than a flag: `--config` reports the same
// 2-of-4 violations as a bare run, `--no-ignore` disables `.eslintignore`/
// `--ignore-path`/`--ignore-pattern` and not the gitignore walk, `--ignore-path` ADDS
// an ignore file rather than replacing the walk, and naming the hidden file explicitly
// on the command line does not lint it because the filter runs after argument
// expansion. There is no oxlint invocation that lints a gitignored file, so the walk
// has to be ASSERTED. That is `unwalkedSourceFailures` below.
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

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { listGitSourceFiles } from "./git-source-files.mjs";
import {
  matchesSubpathKey,
  publishedKey,
  specifierKind,
  wildcardTargetPath,
  workspaceExportIndex,
} from "./package-exports.mjs";

// The four resolvers live in package-exports.mjs (their shared home) and were
// re-exported from here when the move happened, so a consumer that read them off
// this module before the move keeps working.
export {
  publishedKey,
  specifierKind,
  wildcardTargetPath,
  workspaceExportIndex,
} from "./package-exports.mjs";

/** The one config oxlint is allowed to read, repo-relative. */
export const ROOT_OXLINT_CONFIG = ".oxlintrc.json";

const RESTRICTED_IMPORTS = "no-restricted-imports";

// The one thing a config author has to know to omit a root group from an override on
// purpose. It is read from the raw JSONC text because `--print-config` drops comments
// (measured: 0 hits for the prose already written above two of the sites), and it is
// deliberately in the config rather than in a table here — a declaration hosted in
// this file would be a second copy of the fact, in a file the person editing
// `.oxlintrc.json` is not looking at, which is the exact shape the copy rule exists
// to end.
const OMISSION_MARKER = "oxlint-omission:";

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

// Every extension oxlint and oxfmt open when they walk a directory. The list is
// module-private on purpose: it is one rule's input, and exporting it would invite a
// second consumer to re-derive the walked surface from it and drift.
//
// `:(glob)` is required for `**` to mean "any depth INCLUDING none". Measured in a
// fixture holding four `.ts` files, two at the root: the same pathspec without the
// magic returns only the two nested ones, because `**/` then demands an intervening
// directory. A rule that enumerated half the tree would report success over the half
// it never read, so the magic prefix is load-bearing rather than decorative.
const WALKED_SOURCE_PATTERNS = [
  ":(glob)**/*.ts",
  ":(glob)**/*.tsx",
  ":(glob)**/*.js",
  ":(glob)**/*.jsx",
  ":(glob)**/*.mjs",
  ":(glob)**/*.cjs",
  ":(glob)**/*.mts",
  ":(glob)**/*.cts",
];

const CHECK_IGNORE = "git check-ignore --no-index -v";

/**
 * Tracked source files that oxlint and oxfmt will never open, because a gitignore
 * rule excludes them from the walk.
 *
 * Enumeration is `listGitSourceFiles`, which needs no new collector: its
 * `--exclude-standard` filters only the `--others` half, so `--cached` still
 * contributes tracked-and-ignored paths. That asymmetry is exactly the surface wanted.
 * An untracked-and-ignored file is correctly out of scope by construction — it cannot
 * reach CI, so a linter that never opens it costs nothing.
 *
 * The verdict comes from git rather than from a gitignore parser of our own, so the
 * failure names the ignore file, its line and the pattern with no work here. Two flags
 * are load-bearing and were measured, not assumed:
 *
 *   - `--no-index` is REQUIRED. Without it git consults the index and reports ZERO
 *     hits for a tracked-and-ignored file, which is this rule's entire subject
 *     reappearing as a flag;
 *   - `-v` is what makes the failure locatable rather than a bare filename.
 *
 * `git check-ignore`'s exit code is a three-way answer, not a boolean: 0 = hits,
 * 1 = no hits, 128 = git failed. So the status is branched on explicitly. A
 * `try { … } catch { return [] }` around it would fold 128 — a bad pathspec, a corrupt
 * repo, a git that is not there — into the green path, recreating in a new rule the
 * fail-open shape this whole file exists to end. For the same reason `checked === 0`
 * is a failure rather than a pass, and a `-v` row this reader cannot parse is a
 * failure rather than a skip.
 *
 * @param {string} root
 * @returns {{failures: string[], checked: number, hidden: Array<{file: string, ignoreFile: string, line: string, pattern: string}>}}
 */
export function unwalkedSourceFailures(root) {
  const files = listGitSourceFiles(WALKED_SOURCE_PATTERNS, root);
  if (files.length === 0) {
    return {
      checked: 0,
      hidden: [],
      failures: [
        `no source file was enumerated across the ${WALKED_SOURCE_PATTERNS.length} extensions oxlint and oxfmt walk, so this check examined nothing. An empty read reports success exactly like a repo whose whole surface is visible.`,
      ],
    };
  }

  const result = spawnSync("git", ["check-ignore", "--no-index", "--stdin", "-v"], {
    cwd: root,
    input: `${files.join("\n")}\n`,
    encoding: "utf8",
  });

  if (result.error !== undefined) {
    return {
      checked: files.length,
      hidden: [],
      failures: [
        `\`${CHECK_IGNORE}\` did not run (${result.error.message}). It is the only reader of which files oxlint's walk can reach, so without it this check would pass over ${files.length} unexamined file(s).`,
      ],
    };
  }
  // 1 is the green answer — "no listed path is ignored" — and it is the ONLY non-zero
  // status that means anything but trouble.
  if (result.status === 1) return { checked: files.length, hidden: [], failures: [] };
  if (result.status !== 0) {
    return {
      checked: files.length,
      hidden: [],
      failures: [
        `\`${CHECK_IGNORE}\` exited ${result.status} rather than 0 (hits) or 1 (none)${result.stderr.trim() === "" ? "" : `: ${result.stderr.trim()}`}. A git failure must redden this check rather than read as "nothing is hidden".`,
      ],
    };
  }

  const failures = [];
  const hidden = [];
  for (const row of result.stdout.split("\n").filter(Boolean)) {
    // `<ignore file>:<line>:<pattern>\t<path>`. The source is matched lazily so a
    // pattern holding a colon stays in the pattern half.
    const parsed = /^(.*?):(\d+):(.*)\t(.*)$/.exec(row);
    if (parsed === null) {
      failures.push(
        `\`${CHECK_IGNORE}\` emitted a row this reader cannot parse (${JSON.stringify(row)}), so the file it names went unchecked. Its documented shape is \`<ignore file>:<line>:<pattern>\\t<path>\`; a git release that changes it must fail this check rather than quietly report nothing.`,
      );
      continue;
    }
    const [, ignoreFile, line, pattern, file] = parsed;
    hidden.push({ file, ignoreFile, line, pattern });
    failures.push(
      `${file} is tracked, but ${ignoreFile}:${line} ("${pattern}") removes it from the file walk. A gitignore line does not untrack an already-tracked file — it still ships, still compiles and still runs in CI, while oxlint and oxfmt never open it, so no fence in ${ROOT_OXLINT_CONFIG} can fire on it and pnpm lint exits 0. Delete the ignore line; to exempt the file from linting use "ignorePatterns", and to exempt it from one rule use an "overrides" entry, both in ${ROOT_OXLINT_CONFIG}.`,
    );
  }

  return { checked: files.length, hidden, failures };
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
      failure: `\`${invocation}\` did not run (${error instanceof Error ? error.message : String(error)}). The restricted-specifier rules read the config through oxlint, so without it they would examine nothing.`,
    };
  }

  let config;
  try {
    config = JSON.parse(stdout);
  } catch (error) {
    return {
      failure: `\`${invocation}\` did not emit JSON (${error instanceof Error ? error.message : String(error)}). Its resolved shape is an internal representation, not a documented contract, so a release that changes it must fail this check rather than silently read nothing.`,
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
 * `restrictedGroupCopyFailures` below compares the group ARRAYS and MESSAGES across
 * these same sites and reads them from here rather than re-deriving the reader.
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
 * @typedef {{group: string[], message: string|null}} FenceGroup
 * @typedef {{where: string, groups: FenceGroup[]}} FenceSite
 * @typedef {{rootGroups: number, siteCount: number, restated: number,
 *            declared: number, failures: string[]}} FenceCopyReport
 */

/**
 * Every group the ROOT fence holds must be restated byte-identically in every
 * override that carries the rule, or be named there by a declared omission.
 *
 * An oxlint `overrides` entry REPLACES a rule's options wholesale rather than merging
 * them, so a fence that must apply to a subset of the repo cannot be written as one
 * added group: the override has to restate every group the root list holds. That makes
 * the copies real and unavoidable, and nothing else compares them. When the root list
 * moves — a door narrowed, an allowlist repointed, a specifier rewritten — the copy
 * does not follow, `pnpm lint` stays at exit 0, and one tree quietly enforces a stale
 * version of the fence. Same fails-open shape as a group naming a dead specifier, one
 * level up: the group here is alive, it is just not the group anyone edited.
 *
 * The rule per (override site, root group) pair:
 *
 *   - RESTATED iff the site holds a group deep-equal on `group` (an order-sensitive
 *     array of strings) and on `message`. Comparing `group` alone would rebuild the
 *     fail-open inside the fix — an edit to the root's array would make the copy read
 *     as a DIFFERENT fence and nothing would fire;
 *   - DECLARED OMITTED iff the site's own comment region carries
 *     `// oxlint-omission: <specifier> — <reason>` for a specifier the group holds, and
 *     `<reason>` is non-empty. The reason is required and never read, like item 72's
 *     `// path-ok:`;
 *   - otherwise a FAILURE naming the site, its `files`, the specifier, and whether the
 *     group is absent outright or present with a diverged `message` or specifier list.
 *
 * A declaration that can rot is the same bug one level up, so three clauses fail
 * closed on the declarations themselves: a marker naming a specifier NO root group
 * holds is a failure (this is what fires when the root group is repointed and the
 * exemption is left behind), a marker for a group the site DOES restate is a failure
 * (vacuous), and a marker in the root site's own region is a failure.
 *
 * EXTRA groups in an override are allowed and uncounted — `packages/http/src/**` adds
 * a self-barrel group that exists nowhere else, and an addition only narrows a fence.
 * A rule demanding equal lists would report today's healthy tree as broken and would
 * be tuned away inside a week.
 *
 * Pure by construction: `sites` comes from `restrictedImportSites`, `source` is the
 * raw config text, and `scopes[k]` is site k's `files` (or `null` for the root) used
 * only in the diagnostic. That is what lets every case be driven from literal fixtures
 * with no oxlint run and no temp repo.
 *
 * @param {{sites: FenceSite[], source: string, scopes: (string[]|null)[]}} input
 * @returns {FenceCopyReport}
 */
export function restrictedGroupCopyFailures({ sites, source, scopes }) {
  const failures = [];
  const empty = { rootGroups: 0, siteCount: 0, restated: 0, declared: 0, failures };

  const { occurrences, markers } = declaredOmissions(source, sites.length);
  if (occurrences !== sites.length) {
    failures.push(
      `the tracked config text holds ${occurrences} occurrence(s) of "${RESTRICTED_IMPORTS}" but oxlint resolved ${sites.length} rule site(s) carrying it. Comments are absent from the resolved config, so a declared omission can only be attributed to a site by position — and two readers that disagree about the order would attribute it to the wrong one. This refuses rather than skipping the declarations, because skipping them would pass every diverged copy.`,
    );
    return empty;
  }

  const rootIndex = sites.findIndex((site) => site.where === "rules");
  const rootGroups = rootIndex === -1 ? [] : sites[rootIndex].groups;
  const overrideIndexes = sites.map((_site, index) => index).filter((index) => index !== rootIndex);

  // Vacuity floors. A rule that reads nothing passes a healthy repo and a broken one
  // identically, which is the failure being fixed rather than a quiet edge case.
  if (occurrences === 0) {
    failures.push(
      `the tracked config text holds no "${RESTRICTED_IMPORTS}" key at all, so no fence copy could be compared. Every scoped fence in this repo is a copy of the root list; an empty read is a green run over zero assertions.`,
    );
    return empty;
  }
  if (rootGroups.length === 0) {
    failures.push(
      `the root "rules" site carries no ${RESTRICTED_IMPORTS} group, so this rule compared nothing. The copies under "overrides" are copies OF the root list — with no root list every one of them passes by default.`,
    );
    return empty;
  }
  if (overrideIndexes.length === 0) {
    failures.push(
      `no "overrides" entry carries ${RESTRICTED_IMPORTS}, so this rule compared the root list against nothing. Either the scoped fences were deleted, or the reader stopped seeing them; both must be loud.`,
    );
    return empty;
  }

  if (rootIndex !== -1) {
    for (const marker of markers.filter((entry) => entry.site === rootIndex)) {
      failures.push(
        `the root "rules" site declares an omission for "${marker.specifier}". The root cannot omit its own group — a group it does not want is deleted, not exempted. Move the marker into the "overrides" entry that is exempt, or delete the group.`,
      );
    }
  }

  let restated = 0;
  let declared = 0;

  for (const index of overrideIndexes) {
    const site = sites[index];
    const scope = scopeLabel(scopes[index]);
    const siteMarkers = markers.filter((entry) => entry.site === index);

    for (const rootGroup of rootGroups) {
      const label = rootGroup.group.map((specifier) => `"${specifier}"`).join(", ");
      if (site.groups.some((group) => sameFenceGroup(group, rootGroup))) {
        restated += 1;
        continue;
      }

      const marker = siteMarkers.find((entry) => rootGroup.group.includes(entry.specifier));
      if (marker !== undefined) {
        if (marker.reason.length === 0) {
          failures.push(
            `${site.where}${scope} declares an omission for ${label} with no reason after it. Write \`// ${OMISSION_MARKER} ${marker.specifier} — <why this scope is exempt>\`; the reason is never read by this check and is the only thing that tells the next editor whether the exemption is still true.`,
          );
          continue;
        }
        declared += 1;
        continue;
      }

      failures.push(
        `${site.where}${scope} ${divergence(site.groups, rootGroup)} the root group ${label}. An "overrides" entry REPLACES this rule's options wholesale, so the root list is not inherited here — restate the group byte-identically (\`group\` array AND \`message\`), or declare the exemption with \`// ${OMISSION_MARKER} ${rootGroup.group[0]} — <why>\` beside this site's "${RESTRICTED_IMPORTS}" key. Until then this scope enforces a stale version of the fence and \`pnpm lint\` exits 0.`,
      );
    }

    for (const marker of siteMarkers) {
      const holders = rootGroups.filter((group) => group.group.includes(marker.specifier));
      if (holders.length === 0) {
        failures.push(
          `${site.where}${scope} declares an omission for "${marker.specifier}", which no root ${RESTRICTED_IMPORTS} group holds. The root list moved and the exemption was left behind, so this scope is now exempt from nothing and the group the root DID add is unrestated here. Repoint the marker at the specifier the root fences now, or delete it.`,
        );
        continue;
      }
      if (holders.length > 1) {
        failures.push(
          `${site.where}${scope} declares an omission for "${marker.specifier}", which ${holders.length} different root groups hold, so the exemption names no single group. Split the root groups or name a specifier that identifies one of them.`,
        );
        continue;
      }
      if (site.groups.some((group) => sameFenceGroup(group, holders[0]))) {
        failures.push(
          `${site.where}${scope} declares an omission for "${marker.specifier}" AND restates the group holding it. A declaration nobody needs rots into one nobody checks — delete the marker, or delete the restated group if this scope really is exempt.`,
        );
      }
    }
  }

  return {
    rootGroups: rootGroups.length,
    siteCount: overrideIndexes.length,
    restated,
    declared,
    failures,
  };
}

/**
 * Which declared omissions the raw config text carries, and for which site.
 *
 * Comments do not survive `oxlint --print-config`, so the declaration has to come from
 * the tracked JSONC text, and the text has to be attributed to the sites the resolver
 * reported. There is no JSONC parser here to ask for positions — a `scripts/*.mjs`
 * cannot import a workspace package — so the attribution is positional: split the
 * source on the rule key, and region k is the text between occurrence k and occurrence
 * k+1, which puts a comment written immediately above a key inside that key's region.
 *
 * The caller REFUSES when `occurrences` disagrees with `siteCount`; that mismatch is
 * the only way the two readers can disagree about order, and the markers are withheld
 * so the refusal cannot be mistaken for a clean read. Note the direction of the
 * residual risk: if the rule key ever appears inside a `message`, the regions shift and
 * a declaration lands on the WRONG site, which surfaces as a stale or vacuous marker —
 * red, not silent.
 *
 * @param {string} source
 * @param {number} siteCount
 * @returns {{occurrences: number,
 *            markers: {site: number, specifier: string, reason: string}[]}}
 */
function declaredOmissions(source, siteCount) {
  const regions = source.split(`"${RESTRICTED_IMPORTS}"`);
  const occurrences = regions.length - 1;
  if (occurrences !== siteCount) return { occurrences, markers: [] };

  const markers = [];
  for (let site = 0; site < occurrences; site += 1) {
    for (const line of regions[site].split("\n")) {
      const at = line.indexOf(OMISSION_MARKER);
      // The marker is only a marker inside a comment. A config that spells it in a
      // `message` string is describing the mechanism, not invoking it.
      if (at === -1 || !line.slice(0, at).includes("//")) continue;
      const rest = line.slice(at + OMISSION_MARKER.length).trim();
      const [specifier, ...words] = rest.split(/\s+/u);
      if (specifier === undefined || specifier.length === 0) continue;
      // An em dash or a hyphen may separate the specifier from its reason, and neither
      // is the reason. Anything else after the specifier is prose.
      const reason = words
        .join(" ")
        .replace(/^[—-]\s*/u, "")
        .trim();
      markers.push({ site, specifier, reason });
    }
  }
  return { occurrences, markers };
}

/** Two fence groups are the same fence only if BOTH halves match. */
function sameFenceGroup(left, right) {
  return (
    left.message === right.message &&
    left.group.length === right.group.length &&
    left.group.every((specifier, index) => specifier === right.group[index])
  );
}

/**
 * How a site fails to restate a root group, in the words the fix needs. "Absent" and
 * "present but edited" call for different repairs, and a copy sharing a specifier with
 * the root group is the drifted-copy case this rule exists for.
 */
function divergence(siteGroups, rootGroup) {
  const overlapping = siteGroups.find((group) =>
    group.group.some((specifier) => rootGroup.group.includes(specifier)),
  );
  if (overlapping === undefined) return "does not restate";
  if (overlapping.group.length !== rootGroup.group.length) {
    return `restates, with a DIVERGED specifier list (${JSON.stringify(overlapping.group)} against ${JSON.stringify(rootGroup.group)}),`;
  }
  if (!overlapping.group.every((specifier, index) => specifier === rootGroup.group[index])) {
    return `restates, with a DIVERGED specifier list (${JSON.stringify(overlapping.group)} against ${JSON.stringify(rootGroup.group)}),`;
  }
  return "restates, with a DIVERGED message,";
}

/** The site's `files` globs, for a diagnostic that names the scope and not only its index. */
function scopeLabel(scope) {
  if (!Array.isArray(scope) || scope.length === 0) return "";
  return ` (${scope.join(", ")})`;
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

function pinsRootConfig(tokens) {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--config" && tokens[index + 1] === ROOT_OXLINT_CONFIG) return true;
    if (token === `--config=${ROOT_OXLINT_CONFIG}`) return true;
  }
  return false;
}
