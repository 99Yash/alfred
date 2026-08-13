// Fixtures for the type-fixture membership rule. A clean run of a check that
// cannot see a dead guard is indistinguishable from a clean run of a check that
// works, so every case here asserts the MUTATION fails and its clean twin passes.
//
// The fixtures drive the REAL `tsc` binary against dependency-free temp
// projects, because the property under test is "which files does tsc read",
// and a stub that answered that question would be the very glob
// re-implementation the check exists to avoid. Each temp `tsconfig.json` is
// self-contained — `extends: "@alfred/config/…"` resolves to nothing outside
// this repo — and each fixture file imports nothing, so no `node_modules` is
// needed in the temp tree.
//
// `scripts/` has no CI test job and no tsconfig names the tree, so this suite is
// run by `check-type-fixture-programs.mjs` itself — the same wiring
// `check-package-exports.mjs` and `check-web-boundaries.mjs` use. A test file
// that only a job which does not exist would run is a dead guard, which is the
// exact defect this check reports.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  defaultTscPath,
  SCRIPTS_EXCLUDED_ROOT,
  SCRIPTS_PROJECT,
  scriptProgramFailures,
  tscProjectsFor,
  typeFixtureFailures,
} from "./type-fixture-programs.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TSC = defaultTscPath(ROOT);

/** A self-contained project: no `extends`, no lib beyond the compiler's own. */
function project(include) {
  return `${JSON.stringify(
    {
      compilerOptions: { noEmit: true, strict: true, module: "nodenext", target: "es2022" },
      include,
    },
    null,
    2,
  )}\n`;
}

/** `project`, plus the two flags without which tsc reads no `.mjs` file at all. */
function scriptsProject(include) {
  return `${JSON.stringify(
    {
      compilerOptions: {
        noEmit: true,
        allowJs: true,
        checkJs: true,
        module: "nodenext",
        target: "es2022",
      },
      include,
      exclude: ["spikes/**"],
    },
    null,
    2,
  )}\n`;
}

function write(root, relative, content) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** A workspace whose files git lists. Nothing is committed: discovery asks for `--others --exclude-standard`. */
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

/**
 * The same workspace reached two ways: by the tree's real path, and by a symlink to
 * it. `body` is handed both spellings and returns the failures it found.
 *
 * That pair is the shape of every scratch worktree under `/tmp` on macOS, and of
 * every fixture here, because `/tmp` and `/var` are themselves symlinks there. So
 * `home` is realpathed on purpose: an un-realpathed `mkdtemp` root would make the
 * aliased half and the real half break in the SAME way, and the pair would agree on
 * a wrong answer. Both preconditions are asserted rather than commented — a fixture
 * whose control cannot fire is the defect this suite exists to report.
 *
 * @param {string} prefix
 * @param {(tree: string, link: string) => string[]} body
 * @returns {string[]}
 */
function withAliasedWorkspace(prefix, body) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  try {
    const tree = join(home, "tree");
    const link = join(home, "link");
    mkdirSync(tree);
    execFileSync("git", ["init", "--quiet"], { cwd: tree });
    write(tree, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");
    symlinkSync(tree, link);

    const real = realpathSync(tree);
    if (real !== tree) {
      return [`${prefix}: the real half must be its own realpath, received ${real}`];
    }
    if (realpathSync(link) === link) {
      return [`${prefix}: the aliased half must resolve elsewhere, received ${link}`];
    }

    return body(tree, link);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * Drive one shape twice — by the tree's real path, then by a symlink to it — and
 * require the two answers to be identical. The WHOLE answer is compared, not just
 * whether it is empty: a root that leaked into a path set moves `checked` or
 * `projectsProbed` too, and a difference there is the same defect.
 *
 * @template {{failures: string[]}} T
 * @param {string} label
 * @param {(root: string) => T} run
 * @param {string} tree
 * @param {string} link
 * @param {string[]} failures
 * @returns {T} the real half's answer, for the caller to assert on
 */
function agree(label, run, tree, link, failures) {
  const real = run(tree);
  const alias = run(link);
  if (JSON.stringify(real) !== JSON.stringify(alias)) {
    failures.push(
      `${label}: a symlinked root changed the answer (real ${JSON.stringify(real)}, alias ${JSON.stringify(alias)})`,
    );
  }
  return real;
}

/** One package: a manifest with the given `check-types`, one source file, one type fixture. */
function packageWith(fixture, name, checkTypes, { withFixture = true } = {}) {
  write(
    fixture,
    `packages/${name}/package.json`,
    `${JSON.stringify({ name: `@alfred/${name}`, scripts: { "check-types": checkTypes } }, null, 2)}\n`,
  );
  write(fixture, `packages/${name}/src/index.ts`, `export const ${name} = 1;\n`);
  if (withFixture) {
    write(
      fixture,
      `packages/${name}/test/surface.type-test.ts`,
      `import { ${name} } from "../src/index.ts";\n\nconst pinned: number = ${name};\nvoid pinned;\n`,
    );
  }
}

function run(fixture) {
  return typeFixtureFailures(fixture, TSC);
}

function expectClean(label, fixture, failures) {
  const result = run(fixture);
  if (result.failures.length > 0) {
    failures.push(`${label}: expected no failures, received ${JSON.stringify(result.failures)}`);
  }
  return result;
}

function expectFailure(label, fixture, needles, failures) {
  const result = run(fixture);
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

/**
 * 1 — the negative control. A fixture inside the second pass's `include` is
 * clean, and the SAME tree with the `include` narrowed by one directory is not.
 * Without this pair a check that reported nothing would look identical to one
 * that worked.
 */
function includeNarrowingFailures() {
  const failures = [];

  withWorkspace("alfred-type-fixture-include-", (fixture) => {
    packageWith(fixture, "one", "tsc -b && tsc -p tsconfig.test.json");
    write(fixture, "packages/one/tsconfig.json", project(["src"]));
    write(fixture, "packages/one/tsconfig.test.json", project(["src", "test"]));

    const clean = expectClean("fixture inside the second pass", fixture, failures);
    if (clean.checked !== 1) {
      failures.push(
        `fixture inside the second pass: expected checked 1, received ${clean.checked}`,
      );
    }
    if (clean.projectsProbed !== 2) {
      failures.push(
        `fixture inside the second pass: expected projectsProbed 2, received ${clean.projectsProbed}`,
      );
    }

    // One directory too high is the shape that produced two dead guards here.
    write(fixture, "packages/one/tsconfig.test.json", project(["src", "test/type"]));
    expectFailure(
      "include narrowed past the fixture",
      fixture,
      ["packages/one/test/surface.type-test.ts", "in no program"],
      failures,
    );
  });

  return failures;
}

/** 2 — `packages/sync` in miniature: a one-pass `check-types` never reads `test/`. */
function onePassFailures() {
  const failures = [];

  withWorkspace("alfred-type-fixture-onepass-", (fixture) => {
    packageWith(fixture, "two", "tsc -b --emitDeclarationOnly");
    write(fixture, "packages/two/tsconfig.json", project(["src"]));

    expectFailure(
      "one-pass check-types",
      fixture,
      ["packages/two/test/surface.type-test.ts", "in no program"],
      failures,
    );

    // The repair this item ships for `@alfred/sync`, proved to clear it.
    write(fixture, "packages/two/tsconfig.test.json", project(["src", "test"]));
    write(
      fixture,
      "packages/two/package.json",
      `${JSON.stringify(
        {
          name: "@alfred/two",
          scripts: { "check-types": "tsc -b --emitDeclarationOnly && tsc -p tsconfig.test.json" },
        },
        null,
        2,
      )}\n`,
    );
    expectClean("one-pass check-types, repaired", fixture, failures);
  });

  return failures;
}

/**
 * 3 — a `tsconfig.test.json` that exists on disk and that `check-types` never
 * runs. This is the shape an `existsSync` check would pass, and it is the one a
 * future author will reach for: writing the project is only half the repair.
 */
function unrunProjectFailures() {
  const failures = [];

  withWorkspace("alfred-type-fixture-unrun-", (fixture) => {
    packageWith(fixture, "three", "tsc -b --emitDeclarationOnly");
    write(fixture, "packages/three/tsconfig.json", project(["src"]));
    write(fixture, "packages/three/tsconfig.test.json", project(["src", "test"]));

    const result = expectFailure(
      "a project on disk that check-types never runs",
      fixture,
      ["packages/three/test/surface.type-test.ts", "in no program"],
      failures,
    );
    if (result.projectsProbed !== 1) {
      failures.push(
        `a project on disk that check-types never runs: only the project the script names may be probed, received projectsProbed ${result.projectsProbed}`,
      );
    }
  });

  return failures;
}

/** 4 — fail closed. A command line naming no project is a loud failure, never a pass. */
function failClosedFailures() {
  const failures = [];

  for (const [label, script, needle] of [
    ["no tsc at all", "echo skipped", "runs no tsc project"],
    ["input files on the command line", "tsc src/index.ts --noEmit", "names input files"],
    ["a dangling -p", "tsc -p", "names no project"],
  ]) {
    withWorkspace("alfred-type-fixture-closed-", (fixture) => {
      packageWith(fixture, "four", script);
      write(fixture, "packages/four/tsconfig.json", project(["src", "test"]));
      expectFailure(label, fixture, [needle], failures);
    });
  }

  // A fixture in a package with no `check-types` script at all.
  withWorkspace("alfred-type-fixture-noscript-", (fixture) => {
    write(fixture, "packages/five/package.json", '{ "name": "@alfred/five" }\n');
    write(fixture, "packages/five/tsconfig.json", project(["src", "test"]));
    write(fixture, "packages/five/test/surface.type-test.ts", "export const five: number = 5;\n");
    expectFailure("no check-types script", fixture, ["declares no `check-types` script"], failures);
  });

  // A project the script names but that is not on disk.
  withWorkspace("alfred-type-fixture-missing-", (fixture) => {
    packageWith(fixture, "six", "tsc -p tsconfig.test.json");
    write(fixture, "packages/six/tsconfig.json", project(["src"]));
    expectFailure("a named project that does not exist", fixture, ["does not exist"], failures);
  });

  return failures;
}

/** 5 — a package with no fixture costs no `tsc` run, and is not a failure. */
function zeroFixtureFailures() {
  const failures = [];

  withWorkspace("alfred-type-fixture-none-", (fixture) => {
    packageWith(fixture, "seven", "tsc -b --emitDeclarationOnly", { withFixture: false });
    write(fixture, "packages/seven/tsconfig.json", project(["src"]));

    const result = expectClean("no fixture anywhere", fixture, failures);
    if (result.checked !== 0 || result.projectsProbed !== 0) {
      failures.push(
        `no fixture anywhere: expected checked 0 and projectsProbed 0, received ${result.checked} and ${result.projectsProbed}`,
      );
    }
  });

  return failures;
}

/** 6 — a fixture that only this worktree has must not pass a gate for a tree nobody else has. */
function untrackedDiscoveryFailures() {
  const failures = [];

  withWorkspace("alfred-type-fixture-ignored-", (fixture) => {
    packageWith(fixture, "eight", "tsc -b --emitDeclarationOnly");
    write(fixture, "packages/eight/tsconfig.json", project(["src"]));
    expectFailure("an untracked fixture is still discovered", fixture, ["in no program"], failures);

    // Gitignored is the one case that leaves the check surface, because CI
    // never sees the file at all.
    write(fixture, ".gitignore", "packages/eight/test/\n");
    expectClean("a gitignored fixture is outside the surface", fixture, failures);
  });

  return failures;
}

/**
 * 8 — the same rule for `scripts/`. The tree joins its program by a glob, so a script
 * the glob does not reach is type-checked by nothing and reads exactly like one that
 * is; every case here is therefore a pair, with the mutation and its clean twin.
 *
 * The fixture writes its project at `SCRIPTS_PROJECT` rather than at a path of its own,
 * so the constant the check reads is the constant under test.
 */
function scriptProgramCoverageFailures() {
  const failures = [];

  const expect = (label, fixture, expected) => {
    const result = scriptProgramFailures(fixture, TSC);
    if (result.checked !== expected.checked) {
      failures.push(`${label}: expected checked ${expected.checked}, received ${result.checked}`);
    }
    if (expected.needles === null) {
      if (result.failures.length > 0) {
        failures.push(
          `${label}: expected no failures, received ${JSON.stringify(result.failures)}`,
        );
      }
      return;
    }
    if (result.failures.length === 0) {
      failures.push(`${label}: expected a reported failure, received none`);
      return;
    }
    for (const needle of expected.needles) {
      if (!result.failures.some((failure) => failure.includes(needle))) {
        failures.push(
          `${label}: the failure must name ${JSON.stringify(needle)}, received ${JSON.stringify(result.failures)}`,
        );
      }
    }
  };

  withWorkspace("alfred-script-program-", (fixture) => {
    write(fixture, SCRIPTS_PROJECT, scriptsProject(["**/*.mjs"]));
    write(fixture, "scripts/one.mjs", "export const one = 1;\n");
    write(fixture, "scripts/nested/two.mjs", "export const two = 2;\n");
    expect("every script in the program", fixture, { checked: 2, needles: null });

    // The mutation the rule exists for. An `include` narrowed to the top level
    // leaves the nested script checked by nothing and looking no different.
    write(fixture, SCRIPTS_PROJECT, scriptsProject(["*.mjs"]));
    expect("include narrowed past a nested script", fixture, {
      checked: 2,
      needles: ["scripts/nested/two.mjs", "in no program", SCRIPTS_PROJECT],
    });
  });

  // A spike is outside the surface on the check's side too, not only in the project's
  // `exclude`. The two spellings of that rule agree here by test rather than by claim.
  withWorkspace("alfred-script-spike-", (fixture) => {
    write(fixture, SCRIPTS_PROJECT, scriptsProject(["**/*.mjs"]));
    write(fixture, "scripts/one.mjs", "export const one = 1;\n");
    write(fixture, `${SCRIPTS_EXCLUDED_ROOT}sandbox/spike.mjs`, "export const spike = 3;\n");
    expect("a spike is outside the surface", fixture, { checked: 1, needles: null });
  });

  // Fail closed. No project on disk is one named failure, never a silent pass over the
  // empty file set tsc reports for a project it cannot read.
  withWorkspace("alfred-script-missing-", (fixture) => {
    write(fixture, "scripts/one.mjs", "export const one = 1;\n");
    expect("no scripts project at all", fixture, {
      checked: 1,
      needles: [SCRIPTS_PROJECT, "no script in the tree can be shown to be type-checked"],
    });
  });

  return failures;
}

/**
 * 9 — one path space. `tsc --listFilesOnly` prints absolute realpaths while a caller
 * may spell the root through a symlink, so a membership test that spans the two
 * spellings answers a different question than the one this check asks: every fixture
 * reads as unread, or — worse — a normalization loose enough to paper over it starts
 * calling unread files members.
 *
 * The green shape alone cannot tell those apart, so the FIRING shape is driven through
 * both spellings too. A normalization that degenerated into a prefix or a basename
 * match would keep the green half green and make the firing half stop reporting.
 */
function aliasedRootFailures() {
  const fixtureDrives = withAliasedWorkspace("alfred-type-fixture-alias-", (tree, link) => {
    const failures = [];
    const run = (root) => typeFixtureFailures(root, TSC);

    packageWith(tree, "one", "tsc -b && tsc -p tsconfig.test.json");
    write(tree, "packages/one/tsconfig.json", project(["src"]));
    write(tree, "packages/one/tsconfig.test.json", project(["src", "test"]));

    const green = agree("an aliased root keeps the green verdict", run, tree, link, failures);
    if (green.failures.length > 0 || green.checked !== 1 || green.projectsProbed !== 2) {
      failures.push(
        `an aliased root keeps the green verdict: expected 1 fixture, 2 probed projects and no failure, received ${JSON.stringify(green)}`,
      );
    }

    write(tree, "packages/one/tsconfig.test.json", project(["src", "test/type"]));
    const fired = agree("an aliased root keeps the reported failure", run, tree, link, failures);
    if (
      !fired.failures.some(
        (failure) =>
          failure.includes("packages/one/test/surface.type-test.ts") &&
          failure.includes("in no program"),
      )
    ) {
      failures.push(
        `an aliased root keeps the reported failure: expected the fixture to be named as unread, received ${JSON.stringify(fired.failures)}`,
      );
    }

    return failures;
  });

  const scriptDrives = withAliasedWorkspace("alfred-script-alias-", (tree, link) => {
    const failures = [];
    const run = (root) => scriptProgramFailures(root, TSC);

    write(tree, SCRIPTS_PROJECT, scriptsProject(["**/*.mjs"]));
    write(tree, "scripts/one.mjs", "export const one = 1;\n");
    write(tree, "scripts/nested/two.mjs", "export const two = 2;\n");

    const green = agree(
      "an aliased root keeps every script in the program",
      run,
      tree,
      link,
      failures,
    );
    if (green.failures.length > 0 || green.checked !== 2) {
      failures.push(
        `an aliased root keeps every script in the program: expected 2 checked and no failure, received ${JSON.stringify(green)}`,
      );
    }

    write(tree, SCRIPTS_PROJECT, scriptsProject(["*.mjs"]));
    const fired = agree(
      "an aliased root keeps the unread script reported",
      run,
      tree,
      link,
      failures,
    );
    if (!fired.failures.some((failure) => failure.includes("scripts/nested/two.mjs"))) {
      failures.push(
        `an aliased root keeps the unread script reported: expected the nested script to be named, received ${JSON.stringify(fired.failures)}`,
      );
    }

    return failures;
  });

  return [...fixtureDrives, ...scriptDrives];
}

/** 7 — the four `check-types` shapes this repo runs today, read directly. */
function projectParseFailures() {
  const failures = [];

  const cases = [
    ["tsc -b --emitDeclarationOnly", ["tsconfig.json"]],
    [
      "tsc -b --emitDeclarationOnly && tsc -p tsconfig.test.json",
      ["tsconfig.json", "tsconfig.test.json"],
    ],
    ["tsc --noEmit && tsc -p tsconfig.test.json", ["tsconfig.json", "tsconfig.test.json"]],
    ["tsc -b", ["tsconfig.json"]],
    [
      "tsc -b packages/one packages/two",
      ["packages/one/tsconfig.json", "packages/two/tsconfig.json"],
    ],
    ["tsc --project ./scoped.json", ["scoped.json"]],
    ["node ../../scripts/clean-package-dist.mjs && tsc -b --force", ["tsconfig.json"]],
    ["tsc --outDir dist -b", ["tsconfig.json"]],
  ];

  for (const [script, expected] of cases) {
    const { projects, problems } = tscProjectsFor(script);
    if (problems.length > 0) {
      failures.push(
        `tscProjectsFor(${JSON.stringify(script)}) reported ${JSON.stringify(problems)}`,
      );
    }
    if (JSON.stringify(projects) !== JSON.stringify(expected)) {
      failures.push(
        `tscProjectsFor(${JSON.stringify(script)}) must yield ${JSON.stringify(expected)}, received ${JSON.stringify(projects)}`,
      );
    }
  }

  return failures;
}

export function typeFixtureProgramsSelfTestFailures() {
  return [
    ...projectParseFailures(),
    ...includeNarrowingFailures(),
    ...onePassFailures(),
    ...unrunProjectFailures(),
    ...failClosedFailures(),
    ...zeroFixtureFailures(),
    ...untrackedDiscoveryFailures(),
    ...scriptProgramCoverageFailures(),
    ...aliasedRootFailures(),
  ];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const failures = typeFixtureProgramsSelfTestFailures();
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }
  console.log("type-fixture-programs self-test passed.");
}
