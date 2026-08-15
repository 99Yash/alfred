// The rule behind `pnpm check:test-typecheck-baseline`: when a package's second
// `tsc` pass excludes files, that `exclude` is a BASELINE of existing debt, and
// it must keep describing reality.
//
// `packages/api/test/**` entered its package's `tsconfig.test.json` program
// carrying 215 diagnostics across 57 files. Repairing them is several PRs of
// behaviour-adjacent editing, so the tree was widened and those 57 files were
// named in an `exclude`. That bought the other 179 a real type check — and it
// bought a new hazard, because an allowlist with no staleness rule is silently
// pre-disarmable: an entry survives after its file is repaired, renamed or
// deleted, and nothing says so. (`packages/api` is deleted; its suites and the
// remains of that baseline moved into the packages they cover, where the same
// shape and the same hazard apply.)
//
// So the list is derived rather than maintained. This module drops the `exclude`,
// asks `tsc` which files are actually dirty, and asserts set-equality with what
// is committed:
//
//   - a listed file that is now clean  -> delete the entry
//   - an unlisted file that is dirty   -> repair it, or justify a new entry
//   - a listed path that does not exist -> delete the entry
//   - a listed path containing a glob   -> spell it as a literal path
//
// The last two are the halves that make a plain allowlist rot. The glob rule is
// the ratchet: `"test/dispatch"` would un-check every file added to that
// directory tomorrow, and nothing about the entry would look wrong.
//
// Three mechanics are deliberate and all three cost a day to relearn:
//
//   - The tsc binary is a PARAMETER. A `mkdtemp` fixture has no `node_modules`,
//     and a symlinked pnpm `.bin` shim reads its `basedir` off `$0`, so a fixture
//     that inherits the shim runs no compiler at all and every drive reads green.
//   - Nothing here memoizes across calls. A fixture that repairs a file and
//     re-runs must see the new answer; a module-level cache returns the
//     pre-mutation one and turns the negative control green in silence.
//   - There is ONE path space here: repo-relative to a realpathed root. A caller
//     may spell the root through a symlink — `/tmp` is a link to `/private/tmp` on
//     macOS, and a scratch worktree under it is reached by both names — while `tsc`
//     prints realpaths from `--listFilesOnly`. Compare the two spellings directly
//     and the sets are disjoint, so every baselined entry reads as unread. The root
//     is realpathed once on entry and every `tsc`-printed path routes through
//     `toRepoRelative`, so no comparison in this module spans two spaces.
//
// The projects are discovered from git, not from a list of package names in this
// file — a hardcoded list rots in exactly the way the `exclude` it polices does.
//
// `check-test-typecheck-baseline.mjs` is the enforcing consumer and
// `test-typecheck-baseline.selftest.mjs` is this module's only executor.

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { listGitSourceFiles } from "./git-source-files.mjs";
import { toRepoRelative } from "./repo-relative.mjs";

/** The second-pass project name every package in this repo uses. */
const TEST_PROJECT = "tsconfig.test.json";

/**
 * The only subtree this gate reasons about. A `tsconfig.test.json` inherits
 * `exclude` entries for build output through `extends`, and those are not debt.
 */
const TEST_ROOT = "test";

/**
 * Where the probe config is written. It must sit beside the real config: `extends`
 * resolves the base project's `include` and its `rootDir: "."` against the base
 * config's own directory, so a probe in a temp directory would type-check a
 * different program than the one being baselined. It is removed in a `finally`.
 */
const PROBE_PREFIX = "tsconfig.test-baseline-probe";

/** Tracked directories a workspace can live under. */
export const DEFAULT_SEARCH_ROOTS = ["apps", "packages"];

/** `path(line,col): error TS1234: message`, as `--pretty false` prints it. */
const DIAGNOSTIC = /^(.+?)\(\d+,\d+\): error TS\d+:/;

/**
 * Every tracked second-pass project, as repo-relative paths.
 *
 * Discovery goes through git rather than a directory walk, so a config that
 * exists only in one worktree cannot make a gate green for a tree nobody else
 * has. The suffix filter is applied here rather than handed to `git ls-files`,
 * because a `**` pathspec crosses `/` inconsistently and silently matches a
 * fraction of what it reads as.
 *
 * @param {string} root
 * @param {string[]} searchRoots
 * @returns {string[]}
 */
export function discoverTestProjects(root, searchRoots = DEFAULT_SEARCH_ROOTS) {
  return listGitSourceFiles(searchRoots, root).filter((file) => file.endsWith(`/${TEST_PROJECT}`));
}

/**
 * The `exclude` a project resolves to, read out of `tsc` rather than parsed here.
 *
 * A `tsconfig.test.json` in this repo is JSONC and uses `extends`, so hand-parsing
 * it would put a second, plausible-looking answer about the project's shape inside
 * the check whose entire job is to police the first one. `--showConfig` is tsc's
 * own answer and prints `exclude` verbatim, still relative to the config's
 * directory.
 *
 * @typedef {{exclude: string[], problem: null} | {exclude: never[], problem: string}} ResolvedExclude
 *
 * @param {string} tscBinary
 * @param {string} root
 * @param {string} projectPath repo-relative path to the project file
 * @returns {ResolvedExclude}
 */
export function resolvedExclude(tscBinary, root, projectPath) {
  if (!existsSync(tscBinary)) return { exclude: [], problem: `no tsc binary at ${tscBinary}` };

  let stdout;
  try {
    stdout = execFileSync(tscBinary, ["-p", projectPath, "--showConfig"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return { exclude: [], problem: `tsc could not resolve ${projectPath}` };
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { exclude: [], problem: `tsc printed no readable config for ${projectPath}` };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { exclude: [], problem: `tsc printed no readable config for ${projectPath}` };
  }

  const raw = /** @type {{exclude?: unknown}} */ (parsed).exclude;
  if (raw === undefined) return { exclude: [], problem: null };
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
    return {
      exclude: [],
      problem: `${projectPath} has an \`exclude\` that is not a list of paths`,
    };
  }
  return { exclude: /** @type {string[]} */ (raw), problem: null };
}

/**
 * The project as it would be with no `exclude`: which files it reads, and which of
 * them carry a diagnostic.
 *
 * Both answers come from the same probe config, written and removed once, because
 * they must describe the same program. `members` is what makes a zero-diagnostic
 * probe safe to believe: "nothing is dirty" and "the probe measured the wrong
 * program" produce identical diagnostic output, and only the file list tells them
 * apart.
 *
 * Both sets are returned as repo-relative paths, against a realpathed root: `tsc`
 * prints realpaths in `--listFilesOnly` and cwd-relative paths in a diagnostic, and
 * a caller may spell the root through a symlink, so the two are only comparable
 * after they route through `toRepoRelative`. Relativizing further, to the package,
 * is the caller's job — a diagnostic in a file OUTSIDE the package stays namable
 * instead of being folded into a path no `exclude` could hold. A diagnostic outside
 * the root at all becomes a `../…` path, which matches no baseline entry and fails
 * the caller's package-prefix filter, exactly as an absolute path did.
 *
 * This function realpaths the root itself rather than trusting its caller, because
 * it is exported and must hold the one-path-space invariant alone.
 *
 * @typedef {{members: Set<string>, dirty: Set<string>, problem: null}
 *          | {members: Set<never>, dirty: Set<never>, problem: string}} ProbeResult
 *
 * @param {string} tscBinary
 * @param {string} root
 * @param {string} projectPath repo-relative path to the project file
 * @returns {ProbeResult}
 */
export function probeWidenedProgram(tscBinary, root, projectPath) {
  if (!existsSync(tscBinary)) {
    return { members: new Set(), dirty: new Set(), problem: `no tsc binary at ${tscBinary}` };
  }

  let realRoot;
  try {
    realRoot = realpathSync(root);
  } catch {
    return { members: new Set(), dirty: new Set(), problem: `no directory at ${root}` };
  }

  const packageDir = projectPath.slice(0, projectPath.length - TEST_PROJECT.length - 1);
  const probeName = `${PROBE_PREFIX}.${process.pid}.json`;
  const probePath = resolve(realRoot, packageDir, probeName);
  if (existsSync(probePath)) {
    return {
      members: new Set(),
      dirty: new Set(),
      problem: `${packageDir}/${probeName} already exists`,
    };
  }

  let listed = "";
  let diagnostics = "";
  try {
    writeFileSync(
      probePath,
      `${JSON.stringify({ extends: `./${TEST_PROJECT}`, exclude: [] }, null, 2)}\n`,
    );
    const project = `${packageDir}/${probeName}`;
    listed = runTsc(tscBinary, realRoot, [project, "--listFilesOnly"]);
    diagnostics = runTsc(tscBinary, realRoot, [project, "--pretty", "false"]);
  } finally {
    if (existsSync(probePath)) unlinkSync(probePath);
  }

  /** @type {Set<string>} */
  const members = new Set();
  for (const line of listed.split("\n")) {
    const file = line.trim();
    if (file.length > 0 && !file.startsWith("error TS"))
      members.add(toRepoRelative(realRoot, file));
  }
  if (members.size === 0) {
    return {
      members: new Set(),
      dirty: new Set(),
      problem: `${projectPath} · the probe read no file, so its diagnostics describe no program`,
    };
  }

  /** @type {Set<string>} */
  const dirty = new Set();
  for (const line of diagnostics.split("\n")) {
    const match = DIAGNOSTIC.exec(line.trim());
    if (match?.[1] !== undefined) dirty.add(toRepoRelative(realRoot, match[1]));
  }
  return { members, dirty, problem: null };
}

/**
 * `tsc -p …`, keeping stdout when it exits non-zero: a project with diagnostics is
 * exactly the run this check wants, and tsc reports them on stdout.
 *
 * @param {string} tscBinary
 * @param {string} root
 * @param {string[]} args
 * @returns {string}
 */
function runTsc(tscBinary, root, args) {
  try {
    return execFileSync(tscBinary, ["-p", ...args], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const partial = /** @type {{stdout?: unknown}} */ (error).stdout;
    return typeof partial === "string" ? partial : "";
  }
}

/**
 * The whole check.
 *
 * Only the `test/` subtree is in scope, on both sides of the comparison. A
 * `tsconfig.test.json` inherits `exclude` entries such as `dist` and
 * `node_modules` through `extends`, and those are build output rather than
 * baselined debt; symmetrically, a diagnostic in `src` — or in another package
 * reached through a project reference — is already red under the package's own
 * `check-types`, so folding it in here would report the same failure twice under
 * a name that suggests a missing `exclude` entry.
 *
 * A project with no `test/` entry costs one `--showConfig` and is reported as
 * carrying no baseline; only a project that actually baselines something is
 * probed, because the probe is the expensive half.
 *
 * `ok: false` carries the drift lists and nothing else — a refusal branch with a
 * payload to write is a refusal that can be talked past.
 *
 * The root is realpathed once here and only the realpathed spelling travels
 * downward, so the verdict and the drift lists do not depend on how the caller
 * spelled it.
 *
 * @typedef {{name: string, excluded: number}} BaselinedPackage
 * @typedef {{ok: true, packages: BaselinedPackage[], projectsProbed: number}
 *          | {ok: false, nowClean: string[], newlyDirty: string[], missing: string[], problems: string[]}} BaselineResult
 *
 * @param {{root: string, tscBinary: string, searchRoots?: string[]}} options
 * @returns {BaselineResult}
 */
export function checkTestTypecheckBaseline({ root, tscBinary, searchRoots }) {
  /** @type {string[]} */
  const nowClean = [];
  /** @type {string[]} */
  const newlyDirty = [];
  /** @type {string[]} */
  const missing = [];
  /** @type {string[]} */
  const problems = [];
  /** @type {BaselinedPackage[]} */
  const packages = [];
  let projectsProbed = 0;

  let realRoot;
  try {
    realRoot = realpathSync(root);
  } catch {
    return {
      ok: false,
      nowClean: [],
      newlyDirty: [],
      missing: [],
      problems: [`no tree at ${root}`],
    };
  }

  const projects = discoverTestProjects(realRoot, searchRoots ?? DEFAULT_SEARCH_ROOTS);

  for (const projectPath of projects) {
    const packageDir = projectPath.slice(0, projectPath.length - TEST_PROJECT.length - 1);
    const resolved = resolvedExclude(tscBinary, realRoot, projectPath);
    if (resolved.problem !== null) {
      problems.push(resolved.problem);
      continue;
    }

    const baselined = resolved.exclude
      .map((entry) => entry.replace(/^\.\//, ""))
      .filter((entry) => entry === TEST_ROOT || entry.startsWith(`${TEST_ROOT}/`));

    packages.push({ name: packageDir, excluded: baselined.length });
    if (baselined.length === 0) continue;

    // Globs and directories are rejected before the probe runs: neither can be
    // matched against a single dirty path, so leaving them to the set comparison
    // would report them as stale for the wrong reason.
    /** @type {Set<string>} */
    const listed = new Set();
    for (const entry of baselined) {
      const repoPath = `${packageDir}/${entry}`;
      if (/[*?]/.test(entry)) {
        missing.push(`${repoPath} · is a glob; spell every baselined file as a literal path`);
        continue;
      }
      let stats;
      try {
        stats = statSync(resolve(realRoot, repoPath));
      } catch {
        missing.push(`${repoPath} · does not exist`);
        continue;
      }
      if (!stats.isFile()) {
        missing.push(
          `${repoPath} · names a directory, which un-checks every file added to it tomorrow; spell every baselined file as a literal path`,
        );
        continue;
      }
      listed.add(repoPath);
    }

    const probe = probeWidenedProgram(tscBinary, realRoot, projectPath);
    projectsProbed += 1;
    if (probe.problem !== null) {
      problems.push(probe.problem);
      continue;
    }

    for (const repoPath of listed) {
      // A baselined file the widened program does not even read cannot be shown to
      // be dirty, so calling it clean would be a guess. Refuse instead: either the
      // `include` no longer reaches it, or the entry is for a file the program
      // never had.
      if (!probe.members.has(repoPath)) {
        problems.push(
          `${repoPath} · is baselined, but the project reads no such file even with \`exclude\` dropped`,
        );
        continue;
      }
      if (!probe.dirty.has(repoPath)) nowClean.push(repoPath);
    }
    const testRoot = `${packageDir}/${TEST_ROOT}/`;
    for (const repoPath of probe.dirty) {
      if (!repoPath.startsWith(testRoot)) continue;
      if (!listed.has(repoPath)) newlyDirty.push(repoPath);
    }
  }

  if (projects.length === 0) {
    problems.push(
      `no ${TEST_PROJECT} found under ${(searchRoots ?? DEFAULT_SEARCH_ROOTS).join(", ")}`,
    );
  }

  if (nowClean.length > 0 || newlyDirty.length > 0 || missing.length > 0 || problems.length > 0) {
    return {
      ok: false,
      nowClean: nowClean.sort(),
      newlyDirty: newlyDirty.sort(),
      missing: missing.sort(),
      problems: problems.sort(),
    };
  }

  return { ok: true, packages, projectsProbed };
}

/** The `tsc` this repo installs, resolved from the root so every project uses one compiler. */
export function defaultTscBinary(root) {
  return join(root, "node_modules", ".bin", "tsc");
}
