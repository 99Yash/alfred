// Fixtures for the oxlint config-resolution rules.
//
// A clean tree passes an armed fence and a dead one identically — the whole lesson
// of the nested-config disarm this file's subject exists to close — so every case
// here asserts that a MUTATION is reported, not merely that the happy path is
// silent. The one-directional cases (a gitignored config, the root config itself)
// assert the documented boundary, and say so.
//
// `scripts/` has no CI test job and `check-types` skips the tree, so this suite is
// run by `check-oxlint-config.mjs` itself, the same wiring
// `check-web-boundaries.mjs` uses.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  ROOT_OXLINT_CONFIG,
  oxlintScripts,
  restrictedGroupCopyFailures,
  restrictedImportSites,
  restrictedSpecifierFailures,
  rootConfigFailures,
  strayOxlintConfigs,
  unpinnedLintScripts,
  unwalkedSourceFailures,
} from "./oxlint-config.mjs";

const ROOT_CONFIG_BODY = `{
  "rules": {
    "no-restricted-imports": ["error", { "patterns": [{ "group": ["@alfred/http"] }] }]
  }
}
`;

const PINNED_MANIFEST = {
  name: "fixture",
  scripts: {
    lint: `oxlint --config ${ROOT_OXLINT_CONFIG}`,
    "lint:fix": `oxlint --fix --config ${ROOT_OXLINT_CONFIG}`,
    check: "pnpm lint && pnpm format:check",
    "format:check": "oxfmt --check apps packages",
  },
};

function write(root, relative, content) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function withFixture(body) {
  const fixture = mkdtempSync(join(tmpdir(), "oxlint-config-"));
  try {
    return body(fixture);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

/**
 * A repository shaped like this one: a git repo, a root oxlint config, and a
 * manifest whose oxlint scripts pin it. Nothing is committed by default —
 * discovery asks git for `--others --exclude-standard`, so an uncommitted fixture
 * exercises the same path a working tree does.
 */
/**
 * @param {string} fixture
 * @param {Record<string, unknown>} [manifest] Whatever the case under test needs the
 *   root manifest to be — including one with no oxlint script at all, which is the
 *   shape that makes the pin rule vacuous.
 */
function initRepo(fixture, manifest = PINNED_MANIFEST) {
  execFileSync("git", ["init", "--quiet"], { cwd: fixture });
  write(fixture, "package.json", `${JSON.stringify(manifest, null, 2)}\n`);
  write(fixture, ROOT_OXLINT_CONFIG, ROOT_CONFIG_BODY);
  write(fixture, "packages/http/src/index.ts", "export const app = 1;\n");
}

function track(fixture) {
  execFileSync("git", ["add", "-A"], { cwd: fixture });
}

function equal(actual, expected, label) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  return left === right ? [] : [`${label}: expected ${right}, received ${left}`];
}

/** The false-positive control. Every rule must be silent on a repo that is correct. */
function cleanFixtureFailures() {
  return withFixture((fixture) => {
    initRepo(fixture);
    track(fixture);
    return [
      ...equal(strayOxlintConfigs(fixture), [], "a clean repo has no stray config"),
      ...equal(unpinnedLintScripts(fixture), [], "a clean repo has no unpinned oxlint script"),
      ...equal(rootConfigFailures(fixture), [], "a clean repo has a usable root config"),
      // The root config is enumerated by the same glob as a stray one, so state
      // that it is subtracted rather than leaving it to the count above.
      ...equal(
        oxlintScripts(fixture).map((entry) => entry.script),
        ["lint", "lint:fix"],
        "oxlint scripts are derived from the manifest",
      ),
    ];
  });
}

/** A nested config, under each name oxlint discovers today, tracked. */
function nestedConfigFailures(name) {
  return withFixture((fixture) => {
    initRepo(fixture);
    write(fixture, `packages/http/src/${name}`, "{}\n");
    track(fixture);
    return equal(
      strayOxlintConfigs(fixture),
      [`packages/http/src/${name}`],
      `a nested ${name} is reported`,
    );
  });
}

/**
 * A nested config that was never `git add`ed. It disarms the subtree for anyone
 * running oxlint in that tree, so the enumeration is `--others`, not `--cached`.
 */
function untrackedNestedConfigFailures() {
  return withFixture((fixture) => {
    initRepo(fixture);
    write(fixture, "apps/web/.oxlintrc.json", "{}\n");
    return equal(
      strayOxlintConfigs(fixture),
      ["apps/web/.oxlintrc.json"],
      "an untracked nested config is reported",
    );
  });
}

/**
 * The documented boundary, asserted so a later reader cannot mistake it for
 * coverage: a gitignored config is invisible here. It cannot reach CI, which
 * clones tracked files. The `--config` pin is what makes it inert locally.
 */
function gitignoredNestedConfigFailures() {
  return withFixture((fixture) => {
    initRepo(fixture);
    write(fixture, ".gitignore", "packages/http/src/.oxlintrc.json\n");
    write(fixture, "packages/http/src/.oxlintrc.json", "{}\n");
    track(fixture);
    return equal(
      strayOxlintConfigs(fixture),
      [],
      "a gitignored nested config is out of scope, by construction",
    );
  });
}

/** An oxlint script that lost the pin resolves the nearest config again. */
function unpinnedScriptFailures() {
  return withFixture((fixture) => {
    initRepo(fixture, {
      ...PINNED_MANIFEST,
      scripts: { ...PINNED_MANIFEST.scripts, lint: "oxlint" },
    });
    track(fixture);
    return equal(
      unpinnedLintScripts(fixture),
      [{ script: "lint", command: "oxlint" }],
      "an oxlint script without --config is reported",
    );
  });
}

/**
 * The mutation that separates "derived from the manifest" from a hardcoded name
 * list: a script this file has never heard of.
 */
function newUnpinnedScriptFailures() {
  return withFixture((fixture) => {
    initRepo(fixture, {
      ...PINNED_MANIFEST,
      scripts: { ...PINNED_MANIFEST.scripts, "lint:ci": "oxlint --format=github" },
    });
    track(fixture);
    return equal(
      unpinnedLintScripts(fixture),
      [{ script: "lint:ci", command: "oxlint --format=github" }],
      "a new oxlint script without --config is reported",
    );
  });
}

/** A pin that names some other file is not a pin. */
function wrongConfigPinFailures() {
  return withFixture((fixture) => {
    initRepo(fixture, {
      ...PINNED_MANIFEST,
      scripts: { ...PINNED_MANIFEST.scripts, lint: "oxlint --config tools/.oxlintrc.json" },
    });
    track(fixture);
    return equal(
      unpinnedLintScripts(fixture),
      [{ script: "lint", command: "oxlint --config tools/.oxlintrc.json" }],
      "a --config naming another file is not a pin",
    );
  });
}

/** A manifest with no oxlint script at all makes the pin rule vacuous. */
function noOxlintScriptFailures() {
  return withFixture((fixture) => {
    initRepo(fixture, { name: "fixture", scripts: { check: "pnpm format:check" } });
    track(fixture);
    return equal(oxlintScripts(fixture), [], "a manifest with no oxlint script enumerates none");
  });
}

/** A missing root config: every pinned invocation would then read nothing. */
function missingRootConfigFailures() {
  return withFixture((fixture) => {
    initRepo(fixture);
    rmSync(join(fixture, ROOT_OXLINT_CONFIG));
    track(fixture);
    const failures = rootConfigFailures(fixture);
    return failures.length === 1 && failures[0].includes(ROOT_OXLINT_CONFIG)
      ? []
      : [`a missing root config must be reported, received ${JSON.stringify(failures)}`];
  });
}

/** An empty root config is a disarmed repo that lints green. */
function emptyRootConfigFailures() {
  return withFixture((fixture) => {
    initRepo(fixture);
    write(fixture, ROOT_OXLINT_CONFIG, "{\n}\n");
    track(fixture);
    const failures = rootConfigFailures(fixture);
    return failures.length === 1 && failures[0].includes("declares no rules")
      ? []
      : [`an empty root config must be reported, received ${JSON.stringify(failures)}`];
  });
}

// --- Restricted-import specifier resolution -------------------------------------
//
// Same discipline, different subject: a fence whose group names a specifier nobody
// can write reports nothing, so every drive below asserts a MUTATION of a resolvable
// specifier is reported, and each one that can carries the control proving the
// unmutated form was silent. The two `ungated` drives assert a documented hole rather
// than coverage, and say so.

/**
 * A repo whose subject is the fences: a workspace list, workspace manifests carrying
 * `exports` maps, and a root config holding the groups under test.
 *
 * Nothing is committed — `listWorkspaces` asks git for `--others --exclude-standard`,
 * so an uncommitted fixture walks the same path a working tree does. The config is
 * read by the same oxlint binary the repo lints with, spawned against this fixture,
 * which is why a directory with no `node_modules` is enough.
 */
function fenceRepo(fixture, { packages, rules, overrides, files = [] }) {
  execFileSync("git", ["init", "--quiet"], { cwd: fixture });
  write(fixture, "package.json", `${JSON.stringify({ name: "fixture" }, null, 2)}\n`);
  write(fixture, "pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
  for (const [dir, manifest] of Object.entries(packages)) {
    write(fixture, `packages/${dir}/package.json`, `${JSON.stringify(manifest, null, 2)}\n`);
    write(fixture, `packages/${dir}/src/index.ts`, "export const value = 1;\n");
  }
  // A wildcard `exports` key is resolved to a concrete file, so a drive whose subject
  // is a live wildcard has to put the file behind it on disk.
  for (const file of files) write(fixture, file, "export const value = 1;\n");
  const config = overrides === undefined ? { rules } : { rules, overrides };
  write(fixture, ROOT_OXLINT_CONFIG, `${JSON.stringify(config, null, 2)}\n`);
}

/** The rule value a config writes for one or more groups. */
function fence(...groups) {
  return {
    "no-restricted-imports": [
      "error",
      { patterns: groups.map((group) => ({ group, message: "fixture fence" })) },
    ],
  };
}

/** One workspace publishing exactly the `exports` map it is given. */
function workspace(name, exportsValue) {
  return { name, version: "0.0.0", exports: exportsValue };
}

function fenceFailures(shape) {
  return withFixture((fixture) => {
    fenceRepo(fixture, shape);
    return restrictedSpecifierFailures(fixture);
  });
}

/**
 * A drive: the fixture must report exactly one failure naming `expected`, and its
 * control must report none. Both halves are required — a check that reddens on
 * everything is as useless as one that reddens on nothing.
 */
/**
 * @param {string} label
 * @param {{mutated: object, expected: string, control?: object}} cases `control` is
 *   optional on purpose: a drive whose mutation is the only claim states none, and a
 *   drive that also has to show the clean twin is silent states one.
 */
function drive(label, { mutated, control, expected }) {
  const failures = [];

  const red = fenceFailures(mutated);
  if (red.failures.length !== 1 || !red.failures[0].includes(expected)) {
    failures.push(
      `${label}: expected one failure containing ${JSON.stringify(expected)}, received ${JSON.stringify(red.failures)}`,
    );
  }

  if (control !== undefined) {
    const green = fenceFailures(control);
    if (green.failures.length !== 0) {
      failures.push(
        `${label}: the control must be silent, received ${JSON.stringify(green.failures)}`,
      );
    }
  }

  return failures;
}

/** A group naming a package no workspace declares — the class item 16 fixed by hand. */
function deadPackageFailures() {
  return drive("a group naming no workspace package is reported", {
    mutated: {
      packages: { live: workspace("@alfred/live", { ".": "./src/index.ts" }) },
      rules: fence(["@alfred/gone/x"]),
    },
    control: {
      packages: {
        live: workspace("@alfred/live", { ".": "./src/index.ts" }),
        gone: workspace("@alfred/gone", { "./x": "./src/index.ts" }),
      },
      rules: fence(["@alfred/gone/x"]),
    },
    expected: 'restricts "@alfred/gone", which no workspace package declares',
  });
}

/** A group naming a subpath the package stopped publishing. */
function deadSubpathFailures() {
  return drive("a group naming an unpublished subpath is reported", {
    mutated: {
      packages: { x: workspace("@alfred/x", { "./a": "./src/index.ts" }) },
      rules: fence(["@alfred/x/b"]),
    },
    control: {
      packages: { x: workspace("@alfred/x", { "./a": "./src/index.ts" }) },
      rules: fence(["@alfred/x/a"]),
    },
    expected: 'restricts a subpath "./b" that @alfred/x\'s exports map does not publish',
  });
}

/**
 * The false-positive control that matters most: the live knowledge fence resolves
 * only through a wildcard key, so a checker that demanded an explicit one would
 * report the repo's own armed fence as dead.
 */
function wildcardKeyFailures() {
  const shape = {
    packages: { x: workspace("@alfred/x", { "./k/*": "./src/k/*.ts" }) },
    rules: fence(["@alfred/x/k/internal"]),
    files: ["packages/x/src/k/internal.ts"],
  };
  const result = fenceFailures(shape);
  return [
    ...equal(result.failures, [], "a subpath published only by a wildcard exports key resolves"),
    ...equal(result.subpathChecked, 1, "and it is gated on its subpath, not waved through"),
    // The half `pnpm check:exports` cannot reach. Its wildcard branch asks whether the
    // target matches SOME file, and `./src/k/*.ts` still matches the survivors, so
    // deleting the one module the fence names leaves every other gate green.
    ...drive("a file deleted behind a live wildcard key is reported", {
      mutated: { ...shape, files: ["packages/x/src/k/other.ts"] },
      control: shape,
      expected:
        'wildcard exports key "./k/*" to "packages/x/src/k/internal.ts", which no file git lists',
    }),
  ];
}

/** A subpath the map SEALS with `null`: published as a key, writable by nobody. */
function sealedSubpathFailures() {
  return drive("a group naming a sealed subpath is reported", {
    mutated: {
      packages: {
        x: workspace("@alfred/x", { ".": "./src/index.ts", "./sealed": null }),
      },
      rules: fence(["@alfred/x/sealed"]),
    },
    control: {
      packages: {
        x: workspace("@alfred/x", { ".": "./src/index.ts", "./sealed": "./src/index.ts" }),
      },
      rules: fence(["@alfred/x/sealed"]),
    },
    expected: 'exports map SEALS ("./sealed" maps to null)',
  });
}

/**
 * The pair that proves the taxonomy. `@alfred/http`'s real map publishes exactly
 * `"."`, so its own `@alfred/http/*` fence resolves through no entry and is correct;
 * deleting the package must still redden it.
 */
function globSpecifierFailures() {
  const accepted = fenceFailures({
    packages: { x: workspace("@alfred/x", { ".": "./src/index.ts" }) },
    rules: fence(["@alfred/x/*"]),
  });

  return [
    ...equal(
      accepted.failures,
      [],
      "a glob specifier over a package that publishes no subpaths is not reported",
    ),
    ...equal(accepted.checked, 1, "and its package half is still gated"),
    ...equal(accepted.subpathChecked, 0, "while its subpath half is not claimed"),
    ...drive("a glob specifier over a package nobody declares is reported", {
      mutated: {
        packages: { x: workspace("@alfred/x", { ".": "./src/index.ts" }) },
        rules: fence(["@alfred/gone/*"]),
      },
      expected: 'restricts "@alfred/gone", which no workspace package declares',
    }),
    ...drive("a package-name pattern matching no workspace is reported", {
      mutated: {
        packages: { x: workspace("@alfred/x", { ".": "./src/index.ts" }) },
        rules: fence(["@other/*"]),
      },
      control: {
        packages: { x: workspace("@alfred/x", { ".": "./src/index.ts" }) },
        rules: fence(["@alfred/*"]),
      },
      expected: "restricts a package pattern that matches no workspace package",
    }),
  ];
}

/**
 * The documented hole, asserted so no later item can cite this check as covering it:
 * a relative literal is counted and never gated. `../..` from the deepest file a
 * fence covers points at a directory with no index, so requiring it to resolve would
 * report a deliberately over-covering pattern as dead.
 */
function relativeSpecifierFailures() {
  const result = fenceFailures({
    packages: { x: workspace("@alfred/x", { ".": "./src/index.ts" }) },
    rules: fence([".", "../../index*"], ["@alfred/x"]),
  });
  return [
    ...equal(result.failures, [], "relative literals are not reported"),
    ...equal(result.ungated, 2, "relative literals are counted as ungated"),
    ...equal(result.checked, 1, "and the resolvable specifier beside them is gated"),
  ];
}

/**
 * The same hole for a package with no `exports` map at all: `.` resolves through
 * `main`, so the subpath half cannot be asserted and must not be guessed.
 */
function unmappedPackageFailures() {
  const result = fenceFailures({
    packages: {
      x: { name: "@alfred/x", version: "0.0.0" },
      y: workspace("@alfred/y", { ".": "./src/index.ts" }),
    },
    rules: fence(["@alfred/x/thing"], ["@alfred/y"]),
  });
  return [
    ...equal(result.failures, [], "a package with no exports map is not reported as dead"),
    ...equal(result.ungated, 1, "its specifier is counted as ungated"),
  ];
}

/**
 * Three of this repo's four rule sites live in `overrides`, and an override REPLACES
 * the rule's options rather than merging, so a fence there is independent. The
 * mutation this drive exists for is a reader that walks `rules` only.
 */
function overrideReachFailures() {
  const shape = (group) => ({
    packages: { x: workspace("@alfred/x", { ".": "./src/index.ts" }) },
    rules: fence(["@alfred/x"]),
    overrides: [{ files: ["packages/x/src/**"], rules: fence([group]) }],
  });
  return drive("a dead specifier inside an overrides entry is reported", {
    mutated: shape("@alfred/gone/x"),
    control: shape("@alfred/x"),
    expected: 'overrides[0] · "@alfred/gone/x"',
  });
}

/** An override that switches the rule off contributes no groups and is not a refusal. */
function allowOverrideFailures() {
  const result = withFixture((fixture) => {
    fenceRepo(fixture, {
      packages: { x: workspace("@alfred/x", { ".": "./src/index.ts" }) },
      rules: fence(["@alfred/x"]),
      overrides: [
        { files: ["packages/x/src/index.ts"], rules: { "no-restricted-imports": "off" } },
      ],
    });
    return restrictedSpecifierFailures(fixture);
  });
  return [
    ...equal(result.failures, [], 'an "off" override is read as no groups, not as a bad shape'),
    ...equal(result.checked, 1, "and the root site is still gated"),
  ];
}

/**
 * The vacuity floor. Both shapes read nothing, and a check that reports success over
 * nothing is the failure this whole file exists to end — one level up from a dead
 * fence, because it hides every dead fence at once.
 */
function vacuousConfigFailures() {
  const packages = { x: workspace("@alfred/x", { ".": "./src/index.ts" }) };
  const examinedNothing = "so this check examined nothing";
  return [
    ...drive("a config with no no-restricted-imports at all is reported", {
      mutated: { packages, rules: { "no-debugger": "error" } },
      expected: examinedNothing,
    }),
    ...drive("a fence with an empty patterns array is reported", {
      mutated: { packages, rules: { "no-restricted-imports": ["error", { patterns: [] }] } },
      expected: examinedNothing,
    }),
  ];
}

/**
 * The reader refuses a resolved rule value it does not recognize instead of reporting
 * zero groups. `--print-config`'s shape is an internal representation, not a
 * contract: an oxlint release that renames it must redden this check, because a
 * reader that came back empty would make every fence in the file invisible while
 * `pnpm check` stayed green.
 *
 * Driven through a real fixture, because oxlint passes an unrecognized options value
 * through verbatim (measured: `["error", 42]` resolves to `["deny", [42]]`), so the
 * refusal is reachable from a config a human could actually write. The override
 * carries a resolvable fence so the refusal is the only failure — without it the
 * fixture also trips the vacuity floor, which is correct but hides which rule fired.
 */
function readerRefusalFailures() {
  const failures = [
    ...drive("an unrecognized options value is refused, not skipped", {
      mutated: {
        packages: { x: workspace("@alfred/x", { ".": "./src/index.ts" }) },
        rules: { "no-restricted-imports": ["error", 42] },
        overrides: [{ files: ["packages/x/src/**"], rules: fence(["@alfred/x"]) }],
      },
      control: {
        packages: { x: workspace("@alfred/x", { ".": "./src/index.ts" }) },
        rules: fence(["@alfred/x"]),
        overrides: [{ files: ["packages/x/src/**"], rules: fence(["@alfred/x"]) }],
      },
      expected: "is neither an object nor an array of them",
    }),
  ];

  // The remaining refusals are shapes oxlint's own config parser rejects before
  // `--print-config` can emit them, so they are driven against the reader directly —
  // it is a pure function of a resolved config, and a future release emitting any of
  // them must not read as zero groups.
  for (const [label, value, expected] of [
    ["a bare number rule value", 42, "neither a severity string nor a [severity, options] array"],
    ["an empty rule array", [], "neither a severity string nor a [severity, options] array"],
    [
      "a patterns entry with no group",
      ["deny", [{ patterns: [{ regex: "^@alfred" }] }]],
      'has no "group" array of specifier strings',
    ],
    [
      "a group holding a non-string",
      ["deny", [{ patterns: [{ group: [7] }] }]],
      'has no "group" array of specifier strings',
    ],
    [
      "a non-array patterns value",
      ["deny", [{ patterns: "@alfred/x" }]],
      '"patterns" is "@alfred/x" rather than an array',
    ],
  ]) {
    const { failures: reported } = restrictedImportSites({
      rules: { "no-restricted-imports": value },
    });
    if (reported.length !== 1 || !reported[0].includes(expected)) {
      failures.push(
        `${label} must be refused with ${JSON.stringify(expected)}, received ${JSON.stringify(reported)}`,
      );
    }
  }

  // A malformed `overrides` container hides every fence inside it.
  for (const [label, overrides, expected] of [
    ["a non-array overrides", {}, 'the resolved config\'s "overrides" is {} rather than an array'],
    ["a non-object overrides entry", [7], "overrides[0] is 7 rather than an object"],
    ["a non-object rules bag", [{ rules: 7 }], "overrides[0].rules is 7 rather than an object"],
  ]) {
    const { failures: reported } = restrictedImportSites({ overrides });
    if (reported.length !== 1 || !reported[0].includes(expected)) {
      failures.push(
        `${label} must be refused with ${JSON.stringify(expected)}, received ${JSON.stringify(reported)}`,
      );
    }
  }

  return failures;
}

// --- Copies of the root fence across scopes --------------------------------------
//
// A scoped fence cannot be written as one added group, because an `overrides` entry
// REPLACES the rule's options wholesale — so every scoped fence is a verbatim COPY of
// the root list, and a copy left behind by an edit to the root lints exactly like a
// copy that is current. The rule is pure, so every drive here is a literal: no repo,
// no oxlint run, and the resolved `sites` shape handed in directly as
// `restrictedImportSites` reports it.
//
// The specifiers below are deliberately not this repo's real doors, and the fixture
// `files` globs deliberately begin with a segment no tracked top-level directory uses:
// a literal that looks like a repo path is itself a `check:script-paths` failure.

const COPY_KEY = '"no-restricted-imports"';
const DOOR_A = "@alfred/fixture-door-a";
const DOOR_B = "@alfred/fixture-door-b";
const A_MESSAGE = "Door A is restricted to its allowlist.";
const B_MESSAGE = "Door B is restricted to its allowlist.";
const FIXTURE_SCOPE = ["fixture-tree/src/**"];

/** One group as the resolver reports it: the specifier array and its message. */
function copyGroup(group, message) {
  return { group, message };
}

/** One rule site as `restrictedImportSites` reports it. A `"off"` site has no groups. */
function copySite(where, ...groups) {
  return { where, groups };
}

/**
 * Config TEXT whose regions are chosen rather than measured: region k is the prose
 * handed in at index k, and it is placed above occurrence k of the rule key, which is
 * exactly where the attribution rule looks for a marker. The trailing value keeps the
 * text shaped like the config without adding another occurrence of the key.
 */
function copySource(...regions) {
  return regions.map((region) => `${region}\n  ${COPY_KEY}: ["error", {}]`).join("\n");
}

/** A declared omission as a config author writes it. */
function omission(specifier, reason) {
  return `        // oxlint-omission: ${specifier} — ${reason}`;
}

/**
 * A drive: the fixture must report exactly one failure per `expected` substring, and no
 * others. Asserting on the RENDERED message rather than on a count alone is the point —
 * a failure fired for the wrong reason reads exactly like the one being claimed.
 *
 * @param {string} label
 * @param {{sites: import("./oxlint-config.mjs").FenceSite[], regions: string[],
 *          scopes: (string[]|null)[], expected: string[],
 *          restated?: number, declared?: number}} shape
 */
function copyDrive(label, { sites, regions, scopes, expected, restated, declared }) {
  const result = restrictedGroupCopyFailures({
    sites,
    source: copySource(...regions),
    scopes,
  });
  const failures = [];

  if (result.failures.length !== expected.length) {
    return [
      `${label}: expected ${expected.length} failure(s), received ${JSON.stringify(result.failures)}`,
    ];
  }
  for (const want of expected) {
    if (result.failures.filter((failure) => failure.includes(want)).length !== 1) {
      failures.push(
        `${label}: expected exactly one failure containing ${JSON.stringify(want)}, received ${JSON.stringify(result.failures)}`,
      );
    }
  }
  if (restated !== undefined) {
    failures.push(...equal(result.restated, restated, `${label}: restated`));
  }
  if (declared !== undefined) {
    failures.push(...equal(result.declared, declared, `${label}: declared`));
  }
  return failures;
}

/** The root list as every drive below starts from it. */
function rootSite() {
  return copySite("rules", copyGroup([DOOR_A], A_MESSAGE), copyGroup([DOOR_B], B_MESSAGE));
}

/** The false-positive control: an override restating both root groups is silent. */
function healthyCopyFailures() {
  return copyDrive("an override restating every root group is silent", {
    sites: [
      rootSite(),
      copySite("overrides[0]", copyGroup([DOOR_A], A_MESSAGE), copyGroup([DOOR_B], B_MESSAGE)),
    ],
    regions: ["", ""],
    scopes: [null, FIXTURE_SCOPE],
    expected: [],
    restated: 2,
    declared: 0,
  });
}

/**
 * An override may ADD a group the root does not carry — `packages/http/src/**`'s
 * self-barrel fence is exactly that, and an addition only narrows. A rule demanding
 * equal lists would report this repo as broken today.
 */
function extraOverrideGroupFailures() {
  return copyDrive("a group the override ADDS is allowed and uncounted", {
    sites: [
      rootSite(),
      copySite(
        "overrides[0]",
        copyGroup([DOOR_A], A_MESSAGE),
        copyGroup([DOOR_B], B_MESSAGE),
        copyGroup(["."], "No self-barrel import."),
      ),
    ],
    regions: ["", ""],
    scopes: [null, FIXTURE_SCOPE],
    expected: [],
    restated: 2,
  });
}

/** The message edited in one copy and not the other — the whole subject, minimal form. */
function messageDriftFailures() {
  return copyDrive("a copy whose message diverged by one character is reported", {
    sites: [
      rootSite(),
      copySite(
        "overrides[0]",
        copyGroup([DOOR_A], `${A_MESSAGE}.`),
        copyGroup([DOOR_B], B_MESSAGE),
      ),
    ],
    regions: ["", ""],
    scopes: [null, FIXTURE_SCOPE],
    expected: [
      `overrides[0] (fixture-tree/src/**) restates, with a DIVERGED message, the root group "${DOOR_A}"`,
    ],
    restated: 1,
  });
}

/** The copy simply does not carry the group, and nothing says that is on purpose. */
function absentCopyFailures() {
  return copyDrive("a root group missing from an override with no declaration is reported", {
    sites: [rootSite(), copySite("overrides[0]", copyGroup([DOOR_B], B_MESSAGE))],
    regions: ["", ""],
    scopes: [null, FIXTURE_SCOPE],
    expected: [`does not restate the root group "${DOOR_A}"`],
    restated: 1,
  });
}

/**
 * The motivating case: a specifier ADDED to the root group only. Keying the copies by
 * their `group` array would make this look like a different fence and fire nothing.
 */
function groupArrayDriftFailures() {
  return copyDrive("a root group that gained a specifier is reported at the stale copy", {
    sites: [
      copySite(
        "rules",
        copyGroup([DOOR_A, `${DOOR_A}/*`], A_MESSAGE),
        copyGroup([DOOR_B], B_MESSAGE),
      ),
      copySite("overrides[0]", copyGroup([DOOR_A], A_MESSAGE), copyGroup([DOOR_B], B_MESSAGE)),
    ],
    regions: ["", ""],
    scopes: [null, FIXTURE_SCOPE],
    expected: ["restates, with a DIVERGED specifier list"],
    restated: 1,
  });
}

/** The sanctioned form: the scope IS the door's allowlist, and says so. */
function declaredOmissionFailures() {
  return copyDrive("a declared omission with a reason is accepted", {
    sites: [rootSite(), copySite("overrides[0]", copyGroup([DOOR_B], B_MESSAGE))],
    regions: ["", omission(DOOR_A, "this tree IS door A's allowlist.")],
    scopes: [null, FIXTURE_SCOPE],
    expected: [],
    restated: 1,
    declared: 1,
  });
}

/** The declaration itself can rot: the root group moved and the exemption stayed. */
function staleOmissionFailures() {
  return copyDrive("a declaration naming a specifier no root group holds is reported", {
    sites: [
      rootSite(),
      copySite("overrides[0]", copyGroup([DOOR_A], A_MESSAGE), copyGroup([DOOR_B], B_MESSAGE)),
    ],
    regions: ["", omission("@alfred/fixture-door-gone", "it used to live here.")],
    scopes: [null, FIXTURE_SCOPE],
    expected: [`declares an omission for "@alfred/fixture-door-gone", which no root`],
    restated: 2,
    declared: 0,
  });
}

/** A declaration for a group the site restates exempts nothing and will rot unread. */
function vacuousOmissionFailures() {
  return copyDrive("a declaration for a group the site restates is reported", {
    sites: [
      rootSite(),
      copySite("overrides[0]", copyGroup([DOOR_A], A_MESSAGE), copyGroup([DOOR_B], B_MESSAGE)),
    ],
    regions: ["", omission(DOOR_A, "supposedly exempt.")],
    scopes: [null, FIXTURE_SCOPE],
    expected: ["AND restates the group holding it"],
    restated: 2,
    declared: 0,
  });
}

/** The reason is required and never read — the only thing that tells the next editor. */
function reasonlessOmissionFailures() {
  return copyDrive("a declaration with no reason is reported", {
    sites: [rootSite(), copySite("overrides[0]", copyGroup([DOOR_B], B_MESSAGE))],
    regions: ["", `        // oxlint-omission: ${DOOR_A}`],
    scopes: [null, FIXTURE_SCOPE],
    expected: ["with no reason after it"],
    restated: 1,
    declared: 0,
  });
}

/** The root cannot exempt itself from its own group: it deletes the group instead. */
function rootRegionOmissionFailures() {
  return copyDrive("a declaration in the root site's own region is reported", {
    sites: [
      rootSite(),
      copySite("overrides[0]", copyGroup([DOOR_A], A_MESSAGE), copyGroup([DOOR_B], B_MESSAGE)),
    ],
    regions: [omission(DOOR_A, "not a thing the root may say."), ""],
    scopes: [null, FIXTURE_SCOPE],
    expected: ["The root cannot omit its own group"],
    restated: 2,
  });
}

/**
 * The positional attribution's own gate. Two readers disagreeing about order is the one
 * way a marker lands on the wrong site, and its outcome must be RED — a skip here would
 * pass every diverged copy in the file.
 */
function regionCountMismatchFailures() {
  return copyDrive("a text/site count mismatch REFUSES rather than skipping", {
    sites: [
      rootSite(),
      copySite("overrides[0]", copyGroup([DOOR_A], A_MESSAGE), copyGroup([DOOR_B], B_MESSAGE)),
      copySite("overrides[1]", copyGroup([DOOR_A], A_MESSAGE), copyGroup([DOOR_B], B_MESSAGE)),
    ],
    regions: ["", ""],
    scopes: [null, FIXTURE_SCOPE, FIXTURE_SCOPE],
    expected: [`holds 2 occurrence(s) of ${COPY_KEY} but oxlint resolved 3 rule site(s)`],
  });
}

/** The vacuity floors: a rule that compared nothing is a failure, not a pass. */
function emptyCopySurfaceFailures() {
  const noRootGroups = copyDrive("a root site with no groups is reported", {
    sites: [copySite("rules"), copySite("overrides[0]", copyGroup([DOOR_A], A_MESSAGE))],
    regions: ["", ""],
    scopes: [null, FIXTURE_SCOPE],
    expected: ["so this rule compared nothing"],
    restated: 0,
  });
  const noOverrides = copyDrive("a config with no override site is reported", {
    sites: [rootSite()],
    regions: [""],
    scopes: [null],
    expected: ["compared the root list against nothing"],
    restated: 0,
  });
  return [...noRootGroups, ...noOverrides];
}

/**
 * A rule-level `"off"` resolves to a site with ZERO groups, so it must declare an
 * omission for EVERY root group. Loud is right: a blanket `"off"` written for one door
 * silently opens every other door the same rule carries.
 */
function severityStringSiteFailures() {
  return copyDrive("an override that disarms the rule is reported once per root group", {
    sites: [rootSite(), copySite("overrides[0]")],
    regions: ["", ""],
    scopes: [null, FIXTURE_SCOPE],
    expected: [
      `does not restate the root group "${DOOR_A}"`,
      `does not restate the root group "${DOOR_B}"`,
    ],
    restated: 0,
    declared: 0,
  });
}

// --- The file walk ---------------------------------------------------------------
//
// A third mechanism, and the one no config can govern: oxlint and oxfmt honor
// `.gitignore` at any depth, so a gitignore line over an already-tracked source file
// removes it from the walk while the file still ships. The drives below separate the
// two states a single flag decides between — TRACKED and hidden (ships, lints nowhere)
// versus merely IGNORED and untracked (cannot reach CI) — because a reader that
// conflated them would report the second and miss the first.

/**
 * A repo whose subject is the WALK: source files at chosen depths, gitignore files at
 * chosen depths, and the `git add -f` that makes the combination possible at all.
 *
 * The two `add` calls are ordered, not redundant. `git add -A` honors gitignore and so
 * skips the hidden files; `git add -f` then forces exactly the declared sources in.
 * That is the item's own premise as a fixture: a gitignore line does not untrack a file
 * that is already tracked. `untracked` files are written AFTER both adds so they stay
 * untracked, which is the negation case.
 *
 * @param {string} fixture
 * @param {{sources?: string[], ignores?: Record<string, string>, untracked?: string[]}} shape
 */
function walkRepo(fixture, { sources = [], ignores = {}, untracked = [] }) {
  execFileSync("git", ["init", "--quiet"], { cwd: fixture });
  write(fixture, "package.json", `${JSON.stringify({ name: "fixture" }, null, 2)}\n`);
  for (const file of sources) write(fixture, file, "export const value = 1;\n");
  for (const [path, body] of Object.entries(ignores)) write(fixture, path, body);
  execFileSync("git", ["add", "-A"], { cwd: fixture });
  if (sources.length > 0) execFileSync("git", ["add", "-f", "--", ...sources], { cwd: fixture });
  for (const file of untracked) write(fixture, file, "export const value = 1;\n");
}

function walkFailures(shape) {
  return withFixture((fixture) => {
    walkRepo(fixture, shape);
    return unwalkedSourceFailures(fixture);
  });
}

/**
 * One hidden-file drive: exactly one failure, naming the file AND the located ignore
 * line, plus the parsed row behind it. The row is asserted separately from the message
 * so that stubbing either field out of the message cannot leave the drive green.
 *
 * @param {string} label
 * @param {{sources?: string[], ignores?: Record<string, string>, untracked?: string[]}} shape
 * @param {{file: string, ignoreFile: string, line: string, pattern: string}} expected
 */
function walkDrive(label, shape, expected) {
  const result = walkFailures(shape);
  const failures = [];

  if (result.failures.length !== 1) {
    return [`${label}: expected exactly one failure, received ${JSON.stringify(result.failures)}`];
  }
  for (const fragment of [expected.file, `${expected.ignoreFile}:${expected.line}`]) {
    if (!result.failures[0].includes(fragment)) {
      failures.push(
        `${label}: the failure must name ${JSON.stringify(fragment)}, received ${JSON.stringify(result.failures[0])}`,
      );
    }
  }
  return [...failures, ...equal(result.hidden, [expected], `${label}: the parsed row`)];
}

/** The false-positive control: a repo whose whole source surface is walked. */
function walkedSourceFailures() {
  const result = walkFailures({ sources: ["src/a.ts", "src/deep/b.tsx", "src/c.mjs"] });
  return [
    ...equal(result.failures, [], "a repo hiding no tracked source reports nothing"),
    ...equal(result.checked, 3, "and every extension it enumerated is counted"),
  ];
}

/**
 * The mechanism at the ROOT. Both `[41 design]` and this item's own text describe the
 * NESTED case, and a rule scoped to "below the repo root" would pass here — measured:
 * a root gitignore line drops a tracked file from the walk just as a nested one does.
 */
function rootIgnoredSourceFailures() {
  return walkDrive(
    "a tracked source hidden by the root gitignore is reported",
    { sources: ["src/a.ts", "src/hidden.ts"], ignores: { ".gitignore": "src/hidden.ts\n" } },
    { file: "src/hidden.ts", ignoreFile: ".gitignore", line: "1", pattern: "src/hidden.ts" },
  );
}

/** The same mechanism at depth, which is where the item first measured it. */
function nestedIgnoredSourceFailures() {
  return walkDrive(
    "a tracked source hidden by a nested gitignore is reported",
    { sources: ["src/a.ts", "src/hidden.ts"], ignores: { "src/.gitignore": "hidden.ts\n" } },
    { file: "src/hidden.ts", ignoreFile: "src/.gitignore", line: "1", pattern: "hidden.ts" },
  );
}

/**
 * The negation drive, and the one that binds the rule to TRACKEDNESS rather than to
 * ignoredness. An untracked-and-ignored file is invisible to CI, which clones tracked
 * files, so a linter that never opens it costs nothing and must not be reported.
 */
function untrackedIgnoredSourceFailures() {
  const result = walkFailures({
    sources: ["src/a.ts"],
    ignores: { ".gitignore": "src/hidden.ts\n" },
    untracked: ["src/hidden.ts"],
  });
  return [
    ...equal(
      result.failures,
      [],
      "an untracked gitignored source is out of scope, by construction",
    ),
    ...equal(result.checked, 1, "and it is not even enumerated"),
  ];
}

/** The vacuity floor: an enumeration that read nothing is a failure, not a pass. */
function emptyWalkSurfaceFailures() {
  const result = walkFailures({ sources: [] });
  return result.failures.length === 1 && result.failures[0].includes("examined nothing")
    ? equal(result.checked, 0, "an empty walk surface reports zero checked")
    : [`an empty walk surface must be reported, received ${JSON.stringify(result.failures)}`];
}

export function oxlintConfigSelfTestFailures() {
  return [
    ...cleanFixtureFailures(),
    ...nestedConfigFailures(".oxlintrc.json"),
    ...nestedConfigFailures(".oxlintrc.jsonc"),
    ...untrackedNestedConfigFailures(),
    ...gitignoredNestedConfigFailures(),
    ...unpinnedScriptFailures(),
    ...newUnpinnedScriptFailures(),
    ...wrongConfigPinFailures(),
    ...noOxlintScriptFailures(),
    ...missingRootConfigFailures(),
    ...emptyRootConfigFailures(),
    ...deadPackageFailures(),
    ...deadSubpathFailures(),
    ...wildcardKeyFailures(),
    ...sealedSubpathFailures(),
    ...globSpecifierFailures(),
    ...relativeSpecifierFailures(),
    ...unmappedPackageFailures(),
    ...overrideReachFailures(),
    ...allowOverrideFailures(),
    ...vacuousConfigFailures(),
    ...readerRefusalFailures(),
    ...healthyCopyFailures(),
    ...extraOverrideGroupFailures(),
    ...messageDriftFailures(),
    ...absentCopyFailures(),
    ...groupArrayDriftFailures(),
    ...declaredOmissionFailures(),
    ...staleOmissionFailures(),
    ...vacuousOmissionFailures(),
    ...reasonlessOmissionFailures(),
    ...rootRegionOmissionFailures(),
    ...regionCountMismatchFailures(),
    ...emptyCopySurfaceFailures(),
    ...severityStringSiteFailures(),
    ...walkedSourceFailures(),
    ...rootIgnoredSourceFailures(),
    ...nestedIgnoredSourceFailures(),
    ...untrackedIgnoredSourceFailures(),
    ...emptyWalkSurfaceFailures(),
  ];
}
