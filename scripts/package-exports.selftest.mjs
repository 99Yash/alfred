// Fixtures for the exports-target rule. A clean run of a check that cannot see a
// rotted entry is indistinguishable from a clean run of a check that works, so
// every case here asserts the MUTATION fails and its clean twin passes.
//
// `scripts/` has no CI test job and no tsconfig names the tree, so this suite is
// run by `check-package-exports.mjs` itself — the same wiring
// `check-web-boundaries.mjs` and `check-consolidation-drift.mjs` use. A test file
// that only a job which does not exist would run is a dead guard.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { exportTargets, matchesSubpathKey, packageExportsFailures } from "./package-exports.mjs";

function write(root, relative, content) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function manifest(root, name, exportsValue) {
  write(
    root,
    `packages/${name}/package.json`,
    `${JSON.stringify({ name: `@alfred/${name}`, exports: exportsValue }, null, 2)}\n`,
  );
}

/**
 * A workspace whose files git lists. Nothing is committed: `listGitSourceFiles`
 * asks for `--others --exclude-standard`, so untracked files count and ignored
 * ones do not, which is the distinction case 2 turns on.
 */
function withWorkspace(prefix, body) {
  const fixture = mkdtempSync(join(tmpdir(), prefix));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: fixture });
    write(fixture, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");
    return body(fixture);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

function expectClean(label, fixture, failures) {
  const result = packageExportsFailures(fixture);
  if (result.failures.length > 0) {
    failures.push(`${label}: expected no failures, received ${JSON.stringify(result.failures)}`);
  }
  return result;
}

function expectFailure(label, fixture, needles, failures) {
  const result = packageExportsFailures(fixture);
  if (result.failures.length === 0) {
    failures.push(`${label}: expected a reported failure, received none`);
    return result;
  }
  for (const needle of needles) {
    if (!result.failures.some((failure) => failure.includes(needle))) {
      failures.push(
        `${label}: the failure must name ${JSON.stringify(needle)}, received ${JSON.stringify(result.failures)}`,
      );
    }
  }
  return result;
}

/** 1 — the class item 02 found by eye: a concrete target whose file was deleted. */
function concreteTargetFailures() {
  const failures = [];

  withWorkspace("alfred-package-exports-concrete-", (fixture) => {
    manifest(fixture, "one", { ".": "./src/index.ts" });
    write(fixture, "packages/one/src/index.ts", "export const one = 1;\n");
    const clean = expectClean("concrete target present", fixture, failures);
    if (clean.checked !== 1) {
      failures.push(`concrete target present: expected checked 1, received ${clean.checked}`);
    }

    rmSync(join(fixture, "packages/one/src/index.ts"));
    expectFailure(
      "concrete target deleted",
      fixture,
      ["packages/one/package.json", '"."', "./src/index.ts"],
      failures,
    );
  });

  return failures;
}

/** 2 — a target present on disk but gitignored, i.e. a file only this tree has. */
function gitignoredTargetFailures() {
  const failures = [];

  withWorkspace("alfred-package-exports-ignored-", (fixture) => {
    manifest(fixture, "two", { ".": "./src/index.ts", "./local": "./src/local.ts" });
    write(fixture, "packages/two/src/index.ts", "export const two = 2;\n");
    write(fixture, "packages/two/src/local.ts", "export const local = 2;\n");
    expectClean("gitignored twin, before ignoring", fixture, failures);

    write(fixture, ".gitignore", "packages/two/src/local.ts\n");
    expectFailure(
      "target present but gitignored",
      fixture,
      ["./src/local.ts", "git lists"],
      failures,
    );
  });

  return failures;
}

/** 3 — `null` is a deliberate block, not a target and not a failure. */
function blockedTargetFailures() {
  const failures = [];

  withWorkspace("alfred-package-exports-blocked-", (fixture) => {
    manifest(fixture, "three", { ".": "./src/index.ts", "./sealed": null });
    write(fixture, "packages/three/src/index.ts", "export const three = 3;\n");

    const result = expectClean("null target", fixture, failures);
    if (result.blocked !== 1) {
      failures.push(`null target: expected blocked 1, received ${result.blocked}`);
    }
    if (result.checked !== 1) {
      failures.push(
        `null target: expected checked 1 (the block is not checked), received ${result.checked}`,
      );
    }
  });

  return failures;
}

/** 4 — a wildcard is a non-emptiness assertion: it fires only when nothing matches. */
function wildcardTargetFailures() {
  const failures = [];

  withWorkspace("alfred-package-exports-wildcard-", (fixture) => {
    manifest(fixture, "four", { "./*": "./src/*.ts" });
    write(fixture, "packages/four/src/one.ts", "export const one = 1;\n");
    write(fixture, "packages/four/src/nested/two.ts", "export const two = 2;\n");
    expectClean("wildcard with matches", fixture, failures);

    // `*` matches across `/` for Node, so the nested file alone must still
    // satisfy the wildcard — deleting only the top-level match is not enough.
    rmSync(join(fixture, "packages/four/src/one.ts"));
    expectClean("wildcard matching only across a slash", fixture, failures);

    // git tracks no empty directory, so a stray sibling is what survives a move
    // that empties `src/` — the same shape web-boundaries.selftest.mjs uses.
    rmSync(join(fixture, "packages/four/src/nested/two.ts"));
    write(fixture, "packages/four/src/.keep", "");
    expectFailure(
      "wildcard matching nothing",
      fixture,
      ["./src/*.ts", "matches no file"],
      failures,
    );
  });

  return failures;
}

/** 5 and 6 — every string leaf of a condition object and of an array is checked. */
function nestedShapeFailures() {
  const failures = [];

  withWorkspace("alfred-package-exports-conditional-", (fixture) => {
    manifest(fixture, "five", {
      ".": { types: "./src/index.d.ts", default: "./src/index.ts" },
    });
    write(fixture, "packages/five/src/index.d.ts", "export declare const five: number;\n");
    write(fixture, "packages/five/src/index.ts", "export const five = 5;\n");
    const clean = expectClean("condition object, both leaves present", fixture, failures);
    if (clean.checked !== 2) {
      failures.push(`condition object: expected checked 2, received ${clean.checked}`);
    }

    rmSync(join(fixture, "packages/five/src/index.d.ts"));
    expectFailure("condition object, one leaf broken", fixture, ["./src/index.d.ts"], failures);
  });

  withWorkspace("alfred-package-exports-array-", (fixture) => {
    manifest(fixture, "six", { ".": ["./src/first.ts", "./src/second.ts"] });
    write(fixture, "packages/six/src/first.ts", "export const first = 6;\n");
    write(fixture, "packages/six/src/second.ts", "export const second = 6;\n");
    const clean = expectClean("array target, both elements present", fixture, failures);
    if (clean.checked !== 2) {
      failures.push(`array target: expected checked 2, received ${clean.checked}`);
    }

    rmSync(join(fixture, "packages/six/src/second.ts"));
    expectFailure("array target, one element broken", fixture, ["./src/second.ts"], failures);
  });

  return failures;
}

/** 7 — a malformed target is reported, never skipped into a green run. */
function malformedTargetFailures() {
  const failures = [];

  const cases = [
    ["a number target", 7, "neither a target string"],
    ["a target with no leading ./", "src/index.ts", 'does not start with "./"'],
    ["a target with two stars", "./src/*/*.ts", 'more than one "*"'],
  ];

  for (const [label, target, needle] of cases) {
    withWorkspace("alfred-package-exports-malformed-", (fixture) => {
      manifest(fixture, "seven", { ".": "./src/index.ts", "./bad": target });
      write(fixture, "packages/seven/src/index.ts", "export const seven = 7;\n");
      write(fixture, "packages/seven/src/index.d.ts", "export declare const seven: number;\n");
      expectFailure(label, fixture, [needle], failures);
    });
  }

  // The shape branches nothing on today's tree exercises, checked directly so a
  // regression in them is not hidden behind a fixture that happens to be clean.
  const shapeCases = [
    [{ ".": [] }, "empty array"],
    [{ ".": {} }, "empty object"],
    [{ ".": { types: "./a.ts", "./mixed": "./b.ts" } }, "mixes subpath keys"],
  ];
  for (const [value, needle] of shapeCases) {
    const reported = exportTargets(value).failures;
    if (!reported.some((failure) => failure.includes(needle))) {
      failures.push(
        `exportTargets must report ${needle} for ${JSON.stringify(value)}, received ${JSON.stringify(reported)}`,
      );
    }
  }

  return failures;
}

/**
 * 8 — every way the surface can resolve nothing while looking clean.
 *
 * The enumeration's own refusals are proved in `workspaces.selftest.mjs`, which owns
 * the code that produces them. What is proved here is the property this check owns:
 * that it SURFACES them rather than returning a clean `checked: 0`. The distinction
 * is load-bearing now that one enumeration feeds four checks — a consumer that drops
 * the failures reports success on a surface nobody resolved.
 */
function degenerateSurfaceFailures() {
  const failures = [];

  // No pnpm-workspace.yaml at all.
  const bare = mkdtempSync(join(tmpdir(), "alfred-package-exports-noyaml-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: bare });
    expectFailure("no pnpm-workspace.yaml", bare, ["pnpm-workspace.yaml"], failures);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }

  // A workspace file with no `packages:` sequence, and one whose sequence is empty.
  for (const [label, body, needle] of [
    ["no packages block", "overrides:\n  a: b\n", "no top-level"],
    ["empty packages block", "packages:\noverrides:\n  a: b\n", "lists no glob"],
  ]) {
    const fixture = mkdtempSync(join(tmpdir(), "alfred-package-exports-yaml-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: fixture });
      write(fixture, "pnpm-workspace.yaml", body);
      expectFailure(label, fixture, ["pnpm-workspace.yaml", needle], failures);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }

  // Globs that resolve zero manifests.
  withWorkspace("alfred-package-exports-nomanifest-", (fixture) => {
    write(fixture, "README.md", "no workspaces here\n");
    expectFailure("globs resolving zero manifests", fixture, ["no package.json"], failures);
  });

  // Manifests that exist and carry no exports map at all.
  withWorkspace("alfred-package-exports-noexports-", (fixture) => {
    write(fixture, "packages/eight/package.json", '{ "name": "@alfred/eight" }\n');
    expectFailure("no manifest carries exports", fixture, ["examined nothing"], failures);
  });

  // Manifests that carry an exports map advertising only blocks.
  withWorkspace("alfred-package-exports-allblocked-", (fixture) => {
    manifest(fixture, "nine", { "./sealed": null });
    expectFailure("every target blocked", fixture, ["examined nothing"], failures);
  });

  return failures;
}

/** 9 — an unparsable manifest is a named failure, not a stack trace. */
function unparsableManifestFailures() {
  const failures = [];

  withWorkspace("alfred-package-exports-unparsable-", (fixture) => {
    manifest(fixture, "ten", { ".": "./src/index.ts" });
    write(fixture, "packages/ten/src/index.ts", "export const ten = 10;\n");
    write(fixture, "packages/broken/package.json", "{ this is not json\n");

    let result;
    try {
      result = packageExportsFailures(fixture);
    } catch (error) {
      failures.push(
        `an unparsable package.json must not throw, received ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (!result.failures.some((failure) => failure.includes("packages/broken/package.json"))) {
      failures.push(
        `an unparsable package.json must be a named failure, received ${JSON.stringify(result.failures)}`,
      );
    }
  });

  return failures;
}

/**
 * The `*` semantics themselves, driven directly.
 *
 * `matchesSubpathKey` has two callers now — this file's `targetProblem` resolves a
 * wildcard TARGET against the files git lists, and `oxlint-config.mjs` resolves a
 * restricted-import specifier against the KEYS a package publishes. Neither reaches
 * every branch through a fixture: `targetProblem` handles a star-free target with a
 * Set lookup and never calls this, so its equality branch is reachable from no
 * caller at all, and no fixture happens to hold a target whose prefix differs while
 * its suffix agrees. Both were confirmed undriven by mutation (breaking either left
 * this whole suite green), which is why the shared semantics are asserted here
 * rather than only through the callers that consume them.
 */
function subpathKeyMatchFailures() {
  const failures = [];
  for (const [key, subpath, expected] of [
    // No `*`: equality, and nothing else. A prefix is not a match.
    ["./a", "./a", true],
    ["./a", "./b", false],
    ["./a", "./a/b", false],
    // A `*` is a prefix plus a literal suffix, and it crosses `/`.
    ["./k/*", "./k/internal", true],
    ["./k/*", "./k/deep/internal", true],
    ["./k/*", "./other/internal", false],
    ["./*.ts", "./src/main.ts", true],
    ["./*.ts", "./src/main.js", false],
    // The prefix half alone must not carry a match, and the suffix half alone
    // must not either — one drive per conjunct.
    ["./k/*.ts", "./j/main.ts", false],
    ["./k/*.ts", "./k/main.js", false],
    // A `*` stands for at least zero characters, never for less than the key needs.
    ["./k/*", "./k/", true],
    ["./ab*yz", "./abyz", true],
    ["./ab*yz", "./ayz", false],
    // The length guard, whose only job is to stop the prefix and the suffix from
    // matching the SAME characters: `./a` starts with `./a` and ends with `a`, and
    // is still not a member of `./a*a`.
    ["./a*a", "./aba", true],
    ["./a*a", "./a", false],
    // A package name is matched by the same rule, which is what makes `@alfred/*`
    // an assertion that some workspace still answers to it.
    ["@alfred/*", "@alfred/http", true],
    ["@alfred/*", "@other/http", false],
  ]) {
    const actual = matchesSubpathKey(key, subpath);
    if (actual !== expected) {
      failures.push(
        `matchesSubpathKey(${JSON.stringify(key)}, ${JSON.stringify(subpath)}): expected ${expected}, received ${actual}`,
      );
    }
  }
  return failures;
}

export function packageExportsSelfTestFailures() {
  return [
    ...subpathKeyMatchFailures(),
    ...concreteTargetFailures(),
    ...gitignoredTargetFailures(),
    ...blockedTargetFailures(),
    ...wildcardTargetFailures(),
    ...nestedShapeFailures(),
    ...malformedTargetFailures(),
    ...degenerateSurfaceFailures(),
    ...unparsableManifestFailures(),
  ];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const failures = packageExportsSelfTestFailures();
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }
  console.log("package-exports self-test passed.");
}
