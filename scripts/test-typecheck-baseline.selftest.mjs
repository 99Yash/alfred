// Fixtures for `test-typecheck-baseline.mjs`, and its only executor: `scripts/`
// has no CI test job, so the check that consumes these rules runs them first and
// refuses to report a clean tree until they pass.
//
// A baseline gate that cannot see drift passes a clean tree exactly like one that
// works, and every drive below is a MUTATION whose expected outcome is a failure.
// The green drive alone would be satisfied by a function that returns `{ok: true}`.
//
// Every fixture path is built segment-wise off the `mkdtemp` root, never off the
// roots object handed to the rules — building it the other way once wrote fixture
// files into a real package's `src/`.
//
// The fixture package is deliberately hermetic: its base `tsconfig.json` extends
// nothing and sets `types: []`, so a temp directory with no `node_modules` still
// gets a real type check. The compiler comes in as a PARAMETER for the same
// reason — a fixture that inherited a pnpm `.bin` shim would run no compiler at
// all and read every drive as green.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkTestTypecheckBaseline, defaultTscBinary } from "./test-typecheck-baseline.mjs";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The one search root the fixtures use. Not a tracked directory name, on purpose. */
const FIXTURE_ROOTS = ["pkg"];
const FIXTURE_PACKAGE = join("pkg", "demo");

const BASE_CONFIG = {
  compilerOptions: {
    strict: true,
    noEmit: true,
    target: "esnext",
    module: "esnext",
    moduleResolution: "bundler",
    skipLibCheck: true,
    types: [],
  },
  include: ["src"],
};

const CLEAN_SOURCE = "export const good: number = 1;\n";
const DIRTY_SOURCE = 'export const bad: number = "not a number";\n';

/**
 * Build a fixture repository and run the rules over it.
 *
 * The tree is always built under `<mkdtemp>/tree` and every fixture path is joined
 * off that, never off the root handed to the rules. With `aliasRoot`, the rules are
 * given `<mkdtemp>/link` — a symlink to the same tree — which is the shape a scratch
 * worktree reached through `/tmp` has on macOS.
 *
 * @param {{exclude?: string[], include?: string[], files?: Record<string, string>, tsc?: string, aliasRoot?: boolean}} shape
 * @returns {{result: ReturnType<typeof checkTestTypecheckBaseline>, root: string, cleanup: () => void}}
 */
function drive(shape) {
  // Realpathed on purpose. `tmpdir()` is itself reached through a symlink on macOS
  // (`/var` -> `/private/var`), so an un-realpathed `mkdtemp` root would make the
  // aliased drive and the plain drive break in the SAME way, and the pair below
  // would agree on a wrong answer.
  const home = realpathSync(mkdtempSync(join(tmpdir(), "alfred-test-baseline-")));
  const cleanup = () => rmSync(home, { recursive: true, force: true });
  const root = join(home, "tree");

  try {
    mkdirSync(root);
    execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "ignore" });

    const packageDir = join(root, FIXTURE_PACKAGE);
    mkdirSync(join(packageDir, "src"), { recursive: true });
    mkdirSync(join(packageDir, "test"), { recursive: true });

    writeFileSync(join(packageDir, "tsconfig.json"), `${JSON.stringify(BASE_CONFIG, null, 2)}\n`);
    writeFileSync(
      join(packageDir, "tsconfig.test.json"),
      `${JSON.stringify(
        {
          extends: "./tsconfig.json",
          compilerOptions: { noEmit: true, rootDir: "." },
          include: shape.include ?? ["src", "test"],
          exclude: shape.exclude ?? [],
        },
        null,
        2,
      )}\n`,
    );

    const files = shape.files ?? {};
    for (const [relative, contents] of Object.entries(files)) {
      const target = join(packageDir, ...relative.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents);
    }

    let drivenRoot = root;
    if (shape.aliasRoot === true) {
      drivenRoot = join(home, "link");
      symlinkSync(root, drivenRoot);
    }

    const result = checkTestTypecheckBaseline({
      root: drivenRoot,
      tscBinary: shape.tsc ?? defaultTscBinary(REPO_ROOT),
      searchRoots: FIXTURE_ROOTS,
    });
    return { result, root, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** The shape every drive starts from: one clean test file, one dirty one, dirty one baselined. */
const BASELINED = {
  exclude: ["test/dirty.ts"],
  files: {
    "src/index.ts": CLEAN_SOURCE,
    "test/clean.ts": CLEAN_SOURCE,
    "test/dirty.ts": DIRTY_SOURCE,
  },
};

/**
 * @param {ReturnType<typeof checkTestTypecheckBaseline>} result
 * @returns {string}
 */
function summarize(result) {
  return result.ok
    ? `ok, packages=${JSON.stringify(result.packages)}`
    : `nowClean=${JSON.stringify(result.nowClean)} newlyDirty=${JSON.stringify(
        result.newlyDirty,
      )} missing=${JSON.stringify(result.missing)} problems=${JSON.stringify(result.problems)}`;
}

/**
 * Run every fixture. An empty list means the rules distinguish a baseline that
 * describes reality from all six ways it can stop doing so.
 *
 * The drives run in this process rather than in a forked child because each one
 * mutates only its own fixture tree — nothing here re-imports the module under
 * test, and the module keeps no cache across calls, so there is no stale answer
 * for a second drive to read.
 *
 * @returns {string[]}
 */
export function testTypecheckBaselineSelfTestFailures() {
  /** @type {string[]} */
  const failures = [];

  /**
   * @param {string} name
   * @param {Parameters<typeof drive>[0]} shape
   * @param {(result: ReturnType<typeof checkTestTypecheckBaseline>) => string | null} assert
   */
  const check = (name, shape, assert) => {
    let driven;
    try {
      driven = drive(shape);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${name} · fixture could not be built: ${message}`);
      return;
    }
    try {
      const complaint = assert(driven.result);
      if (complaint !== null)
        failures.push(`${name} · ${complaint} (got ${summarize(driven.result)})`);
    } finally {
      driven.cleanup();
    }
  };

  // The green drive. It proves the compiler ran and the baseline was matched; on
  // its own it proves nothing about drift, which is what the rest are for.
  check("a baseline that matches reality passes", BASELINED, (result) =>
    result.ok && result.packages.length === 1 && result.packages[0]?.excluded === 1
      ? null
      : "expected one baselined package with one entry",
  );

  // Repairing a file without deleting its entry is the way an allowlist rots
  // quietly: the entry now excludes a clean file and nothing says so.
  check(
    "a repaired file is reported as nowClean",
    { ...BASELINED, files: { ...BASELINED.files, "test/dirty.ts": CLEAN_SOURCE } },
    (result) =>
      !result.ok && result.nowClean.length === 1 && result.nowClean[0]?.endsWith("test/dirty.ts")
        ? null
        : "expected the repaired file under nowClean",
  );

  check(
    "a newly broken unlisted file is reported as newlyDirty",
    { ...BASELINED, files: { ...BASELINED.files, "test/clean.ts": DIRTY_SOURCE } },
    (result) =>
      !result.ok &&
      result.newlyDirty.length === 1 &&
      result.newlyDirty[0]?.endsWith("test/clean.ts")
        ? null
        : "expected the broken file under newlyDirty",
  );

  check(
    "an entry for a file that does not exist is reported as missing",
    { ...BASELINED, exclude: ["test/dirty.ts", "test/deleted.ts"] },
    (result) =>
      !result.ok && result.missing.some((entry) => entry.includes("test/deleted.ts"))
        ? null
        : "expected the absent path under missing",
  );

  // The ratchet. A glob entry un-checks every file added to the directory
  // tomorrow, so it can never be an acceptable baseline entry however dirty the
  // files it covers are today.
  check("a glob entry is refused", { ...BASELINED, exclude: ["test/*.ts"] }, (result) =>
    !result.ok && result.missing.some((entry) => entry.includes("glob"))
      ? null
      : "expected the glob entry under missing",
  );

  check("a directory entry is refused", { ...BASELINED, exclude: ["test"] }, (result) =>
    !result.ok && result.missing.some((entry) => entry.includes("directory"))
      ? null
      : "expected the directory entry under missing",
  );

  // Scoping. `dist` reaches the `exclude` through `extends` in every real package
  // and is build output, not debt; counting it would make the number this gate
  // exists to drive to zero unreachable.
  check(
    "a non-test exclude entry is not counted as baselined",
    { ...BASELINED, exclude: ["dist", "test/dirty.ts"] },
    (result) =>
      result.ok && result.packages[0]?.excluded === 1
        ? null
        : "expected `dist` to be ignored and only the test entry counted",
  );

  // A baselined file the widened program does not read cannot be shown to be
  // dirty. Calling it clean would delete a real entry on a guess.
  check(
    "an entry outside the widened program is refused rather than called clean",
    {
      ...BASELINED,
      include: ["src", "test/kept"],
      files: { ...BASELINED.files, "test/kept/keeper.ts": CLEAN_SOURCE },
    },
    (result) =>
      !result.ok && result.problems.some((problem) => problem.includes("no such file"))
        ? null
        : "expected a refusal for the unread baselined file",
  );

  // No compiler means no answer. The one outcome that must never happen is a
  // green tree, because that is what a fixture inheriting a broken shim produces.
  check(
    "a missing compiler is a refusal, not a pass",
    { ...BASELINED, tsc: join(REPO_ROOT, "node_modules", ".bin", "tsc-that-is-not-installed") },
    (result) =>
      !result.ok && result.problems.some((problem) => problem.includes("no tsc binary"))
        ? null
        : "expected a refusal naming the missing binary",
  );

  /**
   * The same shape driven twice — once by the tree's real path, once by a symlink
   * to it — must produce the same verdict and the same drift lists. `summarize`
   * prints only repo-relative names and package directories, so the two strings are
   * comparable verbatim; a root that leaked into either list would show up as a
   * difference rather than as a silent second path space.
   *
   * @param {string} name
   * @param {Parameters<typeof drive>[0]} shape
   */
  const agree = (name, shape) => {
    let real;
    let alias;
    try {
      real = drive(shape);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${name} · real-root fixture could not be built: ${message}`);
      return;
    }
    try {
      alias = drive({ ...shape, aliasRoot: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${name} · aliased-root fixture could not be built: ${message}`);
      return;
    } finally {
      real.cleanup();
    }
    try {
      const realSummary = summarize(real.result);
      const aliasSummary = summarize(alias.result);
      if (realSummary !== aliasSummary) {
        failures.push(
          `${name} · a symlinked root changed the verdict (real ${realSummary}, alias ${aliasSummary})`,
        );
      }
    } finally {
      alias.cleanup();
    }
  };

  // The one path space. `tsc --listFilesOnly` prints realpaths while the caller may
  // spell the root through a symlink — which is every scratch worktree under `/tmp`
  // on macOS — so a comparison that spans the two spellings reports every baselined
  // entry as a file the project does not read. The green shape alone would not catch
  // it degenerating into a subset or a basename match; the two drift shapes below are
  // the two reasons this gate exists, and both must survive the alias.
  agree("a symlinked root does not change the green verdict", BASELINED);
  agree("a symlinked root does not change the nowClean verdict", {
    ...BASELINED,
    files: { ...BASELINED.files, "test/dirty.ts": CLEAN_SOURCE },
  });
  agree("a symlinked root does not change the newlyDirty verdict", {
    ...BASELINED,
    files: { ...BASELINED.files, "test/clean.ts": DIRTY_SOURCE },
  });

  // No project at all is a refusal too: a search root that matches nothing is how
  // a rename turns this gate into a no-op that still prints a clean line. This one
  // needs no fixture — it asks the real repository about a directory it lacks.
  const empty = checkTestTypecheckBaseline({
    root: REPO_ROOT,
    tscBinary: defaultTscBinary(REPO_ROOT),
    searchRoots: ["no-such-directory"],
  });
  if (empty.ok || !empty.problems.some((problem) => problem.includes("no tsconfig.test.json"))) {
    failures.push(
      `a tree with no test project is a refusal · expected a refusal for an empty search root (got ${summarize(empty)})`,
    );
  }

  return failures;
}
