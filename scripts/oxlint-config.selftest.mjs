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
  rootConfigFailures,
  strayOxlintConfigs,
  unpinnedLintScripts,
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
  ];
}
