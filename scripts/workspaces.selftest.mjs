// Fixtures for the workspace enumeration. Four checks now read their idea of the
// repository's layout from this one module, so an enumeration that comes back empty
// empties four scan surfaces in the same run — and each of them would report success
// on a surface it never resolved. That is the whole reason `listWorkspaces` returns
// `failures` instead of an empty list, and these fixtures are what prove it does.
//
// Every case asserts the shape that would otherwise pass VACUOUSLY: a refusal is
// checked for being reported, not merely for producing no workspaces.
//
// `scripts/` has no CI test job and `check-types` skips the tree, so this suite is
// run by `check-web-boundaries.mjs` itself — the same wiring
// `check-consolidation-drift.mjs` and `check-package-exports.mjs` use. A test file
// that only a job which does not exist would run is a dead guard. The browser fence
// is the convenient host because a vacuous enumeration does the most damage there:
// it silently narrows a fence, where the other three consumers merely read less.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { listWorkspaces } from "./workspaces.mjs";

function write(root, relative, content) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/**
 * A git repository whose files git lists. Nothing is committed: discovery asks for
 * `--others --exclude-standard`, so untracked files count and ignored ones do not,
 * which is the distinction the discovery case turns on.
 */
function withFixture(prefix, body) {
  const fixture = mkdtempSync(join(tmpdir(), prefix));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: fixture });
    return body(fixture);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

function expectFailure(label, result, needle, failures) {
  if (!result.failures.some((failure) => failure.includes(needle))) {
    failures.push(
      `${label}: listWorkspaces must report a failure naming ${JSON.stringify(needle)}, received ${JSON.stringify(result.failures)}`,
    );
  }
}

function expectClean(label, result, failures) {
  if (result.failures.length > 0) {
    failures.push(`${label}: expected no failures, received ${JSON.stringify(result.failures)}`);
  }
}

function expectDirs(label, result, expected, failures) {
  const dirs = result.workspaces.map((workspace) => workspace.dir);
  if (JSON.stringify(dirs) !== JSON.stringify(expected)) {
    failures.push(
      `${label}: expected workspaces ${JSON.stringify(expected)}, received ${JSON.stringify(dirs)}`,
    );
  }
}

/**
 * 1 — every way the declaration itself can resolve nothing.
 *
 * These four assertions moved here from `package-exports.selftest.mjs` with the code
 * they drive; the consumer keeps its own assertion that it surfaces them, which is a
 * different property.
 */
function declarationRefusalFailures() {
  const failures = [];

  withFixture("alfred-workspaces-noyaml-", (fixture) => {
    const result = listWorkspaces(fixture);
    expectFailure("no pnpm-workspace.yaml", result, "pnpm-workspace.yaml", failures);
    expectDirs("no pnpm-workspace.yaml", result, [], failures);
  });

  for (const [label, body, needle] of [
    ["no packages block", "overrides:\n  a: b\n", "no top-level"],
    ["empty packages block", "packages:\noverrides:\n  a: b\n", "lists no glob"],
  ]) {
    withFixture("alfred-workspaces-yaml-", (fixture) => {
      write(fixture, "pnpm-workspace.yaml", body);
      const result = listWorkspaces(fixture);
      expectFailure(label, result, needle, failures);
      expectDirs(label, result, [], failures);
    });
  }

  // A negation is a shape this parser cannot model. The globs it CAN model still
  // resolve, so the failure is the only thing standing between a caller and an
  // enumeration that silently includes a directory pnpm excludes.
  withFixture("alfred-workspaces-negation-", (fixture) => {
    write(fixture, "pnpm-workspace.yaml", 'packages:\n  - "!packages/private"\n  - packages/*\n');
    write(fixture, "packages/one/package.json", '{ "name": "@alfred/one" }\n');
    write(fixture, "packages/private/package.json", '{ "name": "@alfred/private" }\n');
    const result = listWorkspaces(fixture);
    expectFailure("negated glob", result, "!packages/private", failures);
    expectDirs("negated glob", result, ["packages/one", "packages/private"], failures);
  });

  // Globs that are well-formed and resolve no manifest git lists.
  withFixture("alfred-workspaces-nomanifest-", (fixture) => {
    write(fixture, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");
    write(fixture, "README.md", "no workspaces here\n");
    const result = listWorkspaces(fixture);
    expectFailure("globs resolving zero manifests", result, "no package.json", failures);
    expectDirs("globs resolving zero manifests", result, [], failures);
  });

  return failures;
}

/** 2 and 3 — a manifest with no identity, and one that cannot be read at all. */
function manifestIdentityFailures() {
  const failures = [];

  // No `name`. The workspace is still a workspace: `check-doc-symbols` reads its
  // guide by directory and never touches its identity, so dropping it here would
  // silently stop checking a real guide file.
  withFixture("alfred-workspaces-noname-", (fixture) => {
    write(fixture, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");
    write(fixture, "packages/anon/package.json", '{ "private": true }\n');
    const result = listWorkspaces(fixture);
    expectClean("manifest with no name", result, failures);
    expectDirs("manifest with no name", result, ["packages/anon"], failures);
    if (result.workspaces[0]?.name !== null) {
      failures.push(
        `manifest with no name: expected name null, received ${JSON.stringify(result.workspaces[0]?.name)}`,
      );
    }
  });

  // A `name` that is not a string is the same case: identity absent, directory real.
  withFixture("alfred-workspaces-badname-", (fixture) => {
    write(fixture, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");
    write(fixture, "packages/numeric/package.json", '{ "name": 7 }\n');
    const result = listWorkspaces(fixture);
    if (result.workspaces[0]?.name !== null) {
      failures.push(
        `non-string name: expected name null, received ${JSON.stringify(result.workspaces[0]?.name)}`,
      );
    }
  });

  // A manifest that does not parse. Two readdir walks used to skip this silently as
  // a `name`-less directory; a workspace nobody can identify is a reported failure.
  withFixture("alfred-workspaces-unparsable-", (fixture) => {
    write(fixture, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");
    write(fixture, "packages/broken/package.json", '{ "name": "@alfred/broken",,, }\n');
    const result = listWorkspaces(fixture);
    expectFailure("unparsable manifest", result, "packages/broken/package.json", failures);
    expectDirs("unparsable manifest", result, ["packages/broken"], failures);
    if (result.workspaces[0]?.name !== null) {
      failures.push(
        `unparsable manifest: expected name null, received ${JSON.stringify(result.workspaces[0]?.name)}`,
      );
    }
  });

  return failures;
}

/**
 * 4 — a root outside `apps`/`packages`.
 *
 * The three walks this module replaced iterated hardcoded group literals, so a
 * `tools/*` root declared in the yaml was a workspace to pnpm and to nothing else.
 * This case fails the moment a group list comes back.
 */
function undeclaredGroupFailures() {
  const failures = [];

  withFixture("alfred-workspaces-groups-", (fixture) => {
    write(fixture, "pnpm-workspace.yaml", "packages:\n  - apps/*\n  - packages/*\n  - tools/*\n");
    write(fixture, "apps/site/package.json", '{ "name": "site" }\n');
    write(fixture, "packages/lib/package.json", '{ "name": "@alfred/lib" }\n');
    write(fixture, "tools/codegen/package.json", '{ "name": "@alfred/codegen" }\n');

    const result = listWorkspaces(fixture);
    expectClean("three groups", result, failures);
    expectDirs("three groups", result, ["apps/site", "packages/lib", "tools/codegen"], failures);

    const groups = result.workspaces.map((workspace) => workspace.group);
    if (JSON.stringify(groups) !== JSON.stringify(["apps", "packages", "tools"])) {
      failures.push(
        `three groups: every workspace must carry the group its glob declared, received ${JSON.stringify(groups)}`,
      );
    }

    const sources = result.workspaces.map((workspace) => workspace.source);
    const expectedSources = ["apps/site/src", "packages/lib/src", "tools/codegen/src"];
    if (JSON.stringify(sources) !== JSON.stringify(expectedSources)) {
      failures.push(
        `three groups: expected sources ${JSON.stringify(expectedSources)}, received ${JSON.stringify(sources)}`,
      );
    }
  });

  return failures;
}

/**
 * 5 — discovery goes through git.
 *
 * An untracked manifest counts, because CI sees it once it is committed and a check
 * that ignored it would go green on a workspace the next push adds. An ignored one
 * does not, because `existsSync` would otherwise enumerate build output.
 */
function gitDiscoveryFailures() {
  const failures = [];

  withFixture("alfred-workspaces-discovery-", (fixture) => {
    write(fixture, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");
    write(fixture, ".gitignore", "packages/generated/\n");
    write(fixture, "packages/tracked/package.json", '{ "name": "@alfred/tracked" }\n');
    write(fixture, "packages/generated/package.json", '{ "name": "@alfred/generated" }\n');

    const result = listWorkspaces(fixture);
    expectClean("git discovery", result, failures);
    expectDirs("git discovery", result, ["packages/tracked"], failures);
  });

  return failures;
}

export function workspaceSelfTestFailures() {
  return [
    ...declarationRefusalFailures(),
    ...manifestIdentityFailures(),
    ...undeclaredGroupFailures(),
    ...gitDiscoveryFailures(),
  ];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const failures = workspaceSelfTestFailures();
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }
  console.log("workspaces self-test passed.");
}
