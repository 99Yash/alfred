// The rule behind `pnpm check:type-fixtures`: every tracked `*.type-test.ts`
// must be a file of some `tsc` program that its own package's `check-types`
// script runs.
//
// A type fixture is a guard whose entire value is that `tsc` reads it. It
// asserts nothing at runtime, no test runner executes it, and it produces no
// output. So a fixture whose path falls outside the `include` of the project
// its package type-checks is a dead guard: it sits in the tree, it reads as a
// pinned property to anyone who opens it, and it enforces nothing.
//
// This is not hypothetical. `packages/sync/test/triage-tags.type-test.ts` was
// written, reviewed and merged, and `@alfred/sync` had no second `tsc` pass at
// all — a deliberate type error appended to that file left `pnpm check-types`
// at exit 0 for as long as the file existed. Two other packages got the same
// fixture shape right, which is the whole problem: nothing distinguished them.
//
// Membership is answered by `tsc` itself, through `--listFilesOnly`, and never
// by re-implementing `include`/`exclude`/`extends` glob resolution here. A
// plausible-looking wrong answer about which files a project reads is exactly
// the failure this check exists to catch, so the check must not contain one.
// `typescript@7` exposes no JS compiler API (`parseJsonConfigFileContent`,
// `readConfigFile` and `ts.sys` are all `undefined`), so the binary is the only
// door.
//
// The fail-open surface is the other half: reading a `check-types` shell command
// to learn which projects it runs. That parse is hand-rolled, so it fails
// CLOSED — a package that holds a fixture and whose script yields no project is
// a reported failure, never a silent pass.
//
// The rules live here so fixtures can drive them; `check-type-fixture-programs.mjs`
// is the enforcing consumer, and `type-fixture-programs.selftest.mjs` is their
// only executor — `scripts/` has no CI test job and no tsconfig names the tree.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

import { listGitSourceFiles } from "./git-source-files.mjs";
import { listWorkspaces } from "./workspaces.mjs";

const MANIFEST = "package.json";
const FIXTURE_SUFFIX = ".type-test.ts";
const CHECK_TYPES = "check-types";
const TSC_BIN = "node_modules/.bin/tsc";

/**
 * The standalone program that type-checks `scripts/`. The tree is not a workspace, so
 * no package's `check-types` reaches it; the root `check-types` script runs this
 * project directly.
 */
export const SCRIPTS_PROJECT = "scripts/tsconfig.json";

/**
 * The one directory of `scripts/` that stays outside that program. A spike carries its
 * own `package.json` and its own uninstalled dependencies, so including it would report
 * a missing module rather than anything about this repository.
 *
 * This is the check's spelling of the rule. `SCRIPTS_PROJECT` holds a SECOND spelling,
 * project-relative and as a glob (`spikes/**`), and nothing holds the two to each
 * other: tsc's config grammar takes globs, this comparison takes a path prefix. That
 * divergence is stated rather than hidden — whoever changes one must change the other,
 * and the only thing that catches it is a reader.
 */
export const SCRIPTS_EXCLUDED_ROOT = "scripts/spikes/";

/** `scripts/` holds `.mjs` and nothing else that runs; the program's `include` says the same. */
const SCRIPT_FILE = /\.mjs$/;

// Options that consume the token after them. A value mistaken for a positional
// would be read as a project path, so the ones a typecheck script could
// plausibly carry are listed rather than guessed at.
const VALUE_FLAGS = new Set([
  "--outDir",
  "--outFile",
  "--rootDir",
  "--tsBuildInfoFile",
  "--target",
  "--module",
  "--moduleResolution",
  "--jsx",
  "--lib",
  "--typeRoots",
  "--types",
]);

/** The `tsc` this repo installs. Resolved from the root so every project uses one compiler. */
export function defaultTscPath(root) {
  return join(root, TSC_BIN);
}

/**
 * The tsconfig projects one `check-types` command line runs.
 *
 * Four shapes are live in this repo and all four are handled: `tsc -b`
 * (the project is the package's own `tsconfig.json`), `tsc -b <project>`,
 * `tsc -p <project>` / `--project <project>`, and a bare `tsc --noEmit`. A
 * chain joined by `&&` contributes every one of its `tsc` segments, because
 * `packages/http` type-checks its `src` and its `test/` tree in two passes and
 * a fixture only needs to be in one of them.
 *
 * Anything this parser cannot read becomes a `problem`, never an empty-and-quiet
 * project list: a shape nobody has written yet must fail loudly the first time
 * someone writes it, not grant every fixture in that package a free pass.
 */
export function tscProjectsFor(script) {
  const projects = [];
  const problems = [];

  for (const segment of String(script).split(/&&|\|\||;/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    const start = tokens.findIndex((token) => token === "tsc" || token.endsWith("/tsc"));
    if (start === -1) continue; // A non-tsc step (`node scripts/clean-package-dist.mjs`, `pnpm …`).

    const found = [];
    let build = false;
    let inputFiles = false;
    /** @type {string | null} */
    let dangling = null;

    for (let index = start + 1; index < tokens.length; index += 1) {
      const token = tokens[index];

      if (token === "-p" || token === "--project") {
        const value = tokens[index + 1];
        if (value === undefined || value.startsWith("-")) {
          dangling = token;
          break;
        }
        found.push(value);
        index += 1;
        continue;
      }
      if (token.startsWith("--project=")) {
        found.push(token.slice("--project=".length));
        continue;
      }
      if (token === "-b" || token === "--build") {
        build = true;
        continue;
      }
      if (VALUE_FLAGS.has(token)) {
        index += 1;
        continue;
      }
      if (token.startsWith("-")) continue;

      // A positional means a project reference under `-b`, and an input file
      // otherwise — and naming input files makes tsc ignore every tsconfig.
      if (build) found.push(token);
      else inputFiles = true;
    }

    if (dangling !== null) {
      problems.push(`\`${dangling}\` names no project in \`${segment.trim()}\``);
      continue;
    }
    if (inputFiles) {
      problems.push(
        `\`${segment.trim()}\` names input files on the command line, so tsc reads no tsconfig for it`,
      );
      continue;
    }
    if (found.length === 0) found.push("tsconfig.json");
    for (const project of found) projects.push(normalizeProject(project));
  }

  return { projects: [...new Set(projects)], problems };
}

/** `tsc -p some/dir` reads `some/dir/tsconfig.json`; every project is stored as the file. */
function normalizeProject(project) {
  const trimmed = project.replace(/^\.\//, "").replace(/\/+$/, "");
  return trimmed.endsWith(".json") ? trimmed : `${trimmed}/tsconfig.json`;
}

/**
 * Every file a project's program holds, as `tsc` reports it.
 *
 * `--listFilesOnly` parses and resolves without type-checking, so this stays
 * cheap (~0.2 s per project) and — unlike `--noEmit` — does not error on the
 * composite projects every package here extends. The cache is per call rather
 * than per module: a fixture that narrows an `include` and re-runs must see the
 * new answer.
 *
 * `cache` was passed by one call site and declared by nobody until
 * `scripts/tsconfig.json` type-checked this file: the documented option list and the
 * call site had disagreed in silence, which is the shape this program exists to end.
 *
 * @typedef {{files: Set<string>, problem: string | null}} ProgramFileSet
 *
 * @param {string} root
 * @param {string} projectPath
 * @param {{tsc?: string, cache?: Map<string, ProgramFileSet>}} [options]
 * @returns {ProgramFileSet}
 */
export function programFiles(root, projectPath, { tsc = defaultTscPath(root), cache } = {}) {
  const absolute = resolve(root, projectPath);
  const cached = cache?.get(absolute);
  if (cached !== undefined) return cached;

  let result;
  if (!existsSync(tsc)) {
    result = { files: new Set(), problem: `no tsc binary at ${tsc}` };
  } else if (!existsSync(absolute)) {
    result = { files: new Set(), problem: `${projectPath} does not exist` };
  } else {
    let stdout;
    try {
      stdout = execFileSync(tsc, ["-p", absolute, "--listFilesOnly"], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      // tsc reports a malformed project on stdout and exits non-zero; keep
      // whatever it listed so a partial answer is still a named failure.
      const partial = /** @type {{stdout?: unknown}} */ (error).stdout;
      stdout = typeof partial === "string" ? partial : "";
    }
    const files = new Set(
      stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("error TS"))
        .map((line) => resolve(root, line)),
    );
    result =
      files.size === 0
        ? { files, problem: `tsc listed no file for ${projectPath}` }
        : { files, problem: null };
  }

  cache?.set(absolute, result);
  return result;
}

/**
 * The whole check: every tracked type fixture, against its own package's programs.
 *
 * Discovery goes through git, never `existsSync`, so a fixture that exists only
 * in the author's worktree cannot pass a gate green for a tree nobody else has —
 * and one listing serves every workspace, because a per-target `git ls-files`
 * writes `warning: could not open directory` onto this check's own stderr.
 *
 * A project is probed only for a package that holds at least one fixture, so
 * the eleven packages with none cost nothing.
 *
 * `checked` of 0 is reported, not failed: a repository is allowed to hold no
 * type fixtures, and the guarantee that discovery works comes from the self-test
 * rather than from a count on the real tree.
 */
export function typeFixtureFailures(root, tsc = defaultTscPath(root)) {
  const { workspaces, globs, failures } = listWorkspaces(root);
  if (workspaces.length === 0) return { checked: 0, projectsProbed: 0, failures };

  const listed = listGitSourceFiles(globs, root);
  const fixtures = listed.filter((file) => file.endsWith(FIXTURE_SUFFIX));

  // Longest first, so a fixture inside a nested workspace matches that workspace
  // rather than the one above it. The order is this check's `startsWith` concern,
  // not a property of the enumeration.
  const packageDirs = workspaces
    .map((workspace) => workspace.dir)
    .sort((left, right) => right.length - left.length);

  const byPackage = new Map();
  for (const fixture of fixtures) {
    const packageDir = packageDirs.find((dir) => fixture.startsWith(`${dir}/`));
    if (packageDir === undefined) {
      failures.push(`${fixture} · sits in no workspace, so no package's check-types can reach it.`);
      continue;
    }
    const held = byPackage.get(packageDir);
    if (held) held.push(fixture);
    else byPackage.set(packageDir, [fixture]);
  }

  const cache = new Map();
  let projectsProbed = 0;

  for (const [packageDir, held] of byPackage) {
    const script = checkTypesScript(root, packageDir);
    if (script === null) {
      for (const fixture of held) {
        failures.push(
          `${packageDir} · ${fixture} · its package declares no \`${CHECK_TYPES}\` script, so no tsc pass reads it.`,
        );
      }
      continue;
    }

    const { projects, problems } = tscProjectsFor(script);
    for (const problem of problems) failures.push(`${packageDir} · ${problem}.`);

    if (projects.length === 0) {
      for (const fixture of held) {
        failures.push(
          `${packageDir} · ${fixture} · its \`${CHECK_TYPES}\` script (\`${script}\`) runs no tsc project, so nothing here can be shown to read it.`,
        );
      }
      continue;
    }

    const members = new Set();
    for (const project of projects) {
      const projectPath = `${packageDir}/${project}`;
      const { files, problem } = programFiles(root, projectPath, { tsc, cache });
      projectsProbed += 1;
      if (problem !== null) failures.push(`${packageDir} · ${problem}.`);
      for (const file of files) members.add(file);
    }

    for (const fixture of held) {
      if (isMember(root, fixture, members)) continue;
      failures.push(
        `${packageDir} · ${fixture} · is in no program its \`${CHECK_TYPES}\` runs (probed ${projects.join(", ")}), so tsc never reads it.`,
      );
    }
  }

  return { checked: fixtures.length, projectsProbed, failures };
}

/**
 * The same rule as {@link typeFixtureFailures}, one directory over: every tracked
 * script outside {@link SCRIPTS_EXCLUDED_ROOT} must be a file of
 * {@link SCRIPTS_PROJECT}.
 *
 * `scripts/tsconfig.json` selects its files by a glob, so a new script joins the
 * program by existing — which is exactly what makes the failure invisible. A script the
 * glob does not reach, because someone added a directory or narrowed the `include`, is
 * type-checked by nothing and reads identically to one that is checked. The `include`
 * is the thing that rots, so this asks `tsc` which files it actually read instead of
 * re-implementing the glob.
 *
 * Membership goes through {@link programFiles}, so a project that cannot be probed at
 * all — deleted, malformed, or narrowed down to nothing — is one named failure and
 * never a silent pass over an empty file set.
 *
 * @param {string} root
 * @param {string} [tsc]
 * @param {Map<string, ProgramFileSet>} [cache]
 * @returns {{checked: number, failures: string[]}}
 */
export function scriptProgramFailures(root, tsc = defaultTscPath(root), cache) {
  const failures = [];
  const tracked = listGitSourceFiles(["scripts"], root).filter(
    (file) => SCRIPT_FILE.test(file) && !file.startsWith(SCRIPTS_EXCLUDED_ROOT),
  );

  const { files, problem } = programFiles(root, SCRIPTS_PROJECT, cache ? { tsc, cache } : { tsc });
  if (problem !== null) {
    failures.push(
      `${SCRIPTS_PROJECT} · ${problem}, so no script in the tree can be shown to be type-checked.`,
    );
    return { checked: tracked.length, failures };
  }

  for (const script of tracked) {
    if (isMember(root, script, files)) continue;
    failures.push(
      `${script} · is in no program (${SCRIPTS_PROJECT} does not read it), so tsc never checks it. Widen that project's \`include\`, or move the file under \`${SCRIPTS_EXCLUDED_ROOT}\` if it is a spike with dependencies of its own.`,
    );
  }

  return { checked: tracked.length, failures };
}

/** Compare against tsc's own answer under both spellings of the path — a temp dir may be reached through a symlink. */
function isMember(root, fixture, members) {
  const absolute = resolve(root, fixture);
  if (members.has(absolute)) return true;
  try {
    return members.has(realpathSync(absolute));
  } catch {
    return false;
  }
}

function checkTypesScript(root, packageDir) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(root, packageDir, MANIFEST), "utf8"));
  } catch {
    return null;
  }
  const script = parsed?.scripts?.[CHECK_TYPES];
  return typeof script === "string" && script.trim().length > 0 ? script : null;
}
