// The browser boundary, stated once: which packages must never reach the browser
// bundle at runtime, and which trees actually reach that bundle.
//
// The second half used to be a constant (`apps/web/src`), which made the fence
// narrower than the rule it enforces — a new browser-bound package sat outside it
// by construction until somebody remembered to widen the walk. Here the surface is
// derived instead: start at the apps declared browser-bound and follow every runtime
// `@alfred/*` binding into the workspace, so a package that joins the bundle joins
// the fence in the same commit.
//
// The seed is the remaining declaration, and it is deliberate. `apps/*` is
// enumerated from `pnpm-workspace.yaml` but never walked as a browser root; each app
// is declared browser-bound or Node-only by hand, and an app in neither set is a
// reported failure. See the two sets below for why inference was rejected.
//
// This module is pure. `scripts/check-web-boundaries.mjs` is the CLI that exits on
// it, and `scripts/web-boundaries.selftest.mjs` is its fixture suite.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { listGitSourceFiles } from "./git-source-files.mjs";
import { parseImports } from "./ts-imports.mjs";
import { listWorkspaces } from "./workspaces.mjs";

/**
 * Packages a browser runtime file must not load. The `import type { … } from`
 * STATEMENT is allowed: TypeScript erases it, so it cannot ship the package's
 * Node-only dependencies into the bundle.
 *
 * The inline-specifier form is not the same statement and is not allowed.
 * `import { type A } from "@alfred/db"` emits `import {} from "@alfred/db"` under
 * `verbatimModuleSyntax` (`packages/config/tsconfig.base.json:8`) — the module is
 * still evaluated. Only a leading `type` keyword erases; see `isRuntimeLoad`.
 */
export const FORBIDDEN_RUNTIME_PACKAGES = new Set([
  "@alfred/api",
  "@alfred/http",
  "@alfred/auth",
  "@alfred/db",
  "@alfred/env",
  "@alfred/ai",
]);

// Which apps reach a browser bundle is DECLARED, not inferred, and the declaration
// has to be exhaustive over the apps the workspace enumeration lists.
//
// Widening the fence to `apps/*` by directory was the obvious alternative and it is
// wrong: `apps/server` takes runtime `@alfred/db`, `@alfred/env` and `@alfred/auth`
// bindings by design, so walking it as a browser root would report dozens of correct
// imports as violations, and the only way back to green is a suppression list — a
// fence that trains its readers to suppress it. The axis is browser-reachability,
// not directory.
//
// Inferring browser-ness from evidence was the other alternative, and it is worse:
// an SSR or non-Vite browser app has no `index.html`, so inference answers "Node"
// SILENTLY for exactly the app that most needs fencing. A declaration is one line
// and its absence is loud.
//
// Two sets rather than one set plus an implicit "everything else is Node", because
// that implicit default is the bug this replaces: the seed used to be the constant
// `apps/web/src`, so a second browser app was outside the fence by construction and
// the check exited 0. The second set is the record that somebody looked.

/** Apps whose sources reach a browser bundle. The fence seeds from these. */
const BROWSER_ENTRY_APPS = new Set(["apps/web"]);

/** Apps that are Node programs. Listed so a NEW app cannot be silently either. */
const NODE_ONLY_APPS = new Set(["apps/server"]);

/** A browser bundler's entry document, used only to corroborate a NODE_ONLY claim. */
const BUNDLER_ENTRY_DOCUMENT = "index.html";

/** Prose sites that enumerate the forbidden list and must not drift from it. */
const DOC_LIST_SITES = ["docs/reference/architecture.md", "apps/web/AGENTS.md"];

const DOC_MARKER_START = "<!-- forbidden-runtime-packages:start -->";
const DOC_MARKER_END = "<!-- forbidden-runtime-packages:end -->";

const SOURCE_FILE = /\.(ts|tsx)$/;

function packageName(specifier) {
  if (!specifier.startsWith("@alfred/")) return null;
  const [scope, pkg] = specifier.split("/");
  return pkg ? `${scope}/${pkg}` : null;
}

/**
 * Whether an import clause survives to a runtime module load.
 *
 * The subject is the LOAD, not the binding, and the two come apart:
 * `import {} from "@alfred/db"` binds nothing and still evaluates the module.
 * TypeScript erases an import statement only when the `type` keyword leads the
 * clause — `import type { A } from …`. A brace clause whose specifiers each
 * carry an inline `type` is a different statement: under `verbatimModuleSyntax`
 * (`packages/config/tsconfig.base.json:8`, which `apps/web/tsconfig.json`
 * extends) `import { type A } from "@alfred/db"` emits `import {} from
 * "@alfred/db"`, which drags the package's Node-only dependencies into the
 * bundle exactly as a value import would.
 *
 * So the rule is one test, and the precondition is worth stating plainly: this
 * is correct because `verbatimModuleSyntax` is on. If it were turned off,
 * TypeScript would drop an all-`type` clause and this predicate would
 * over-report — loud and conservative, never a missed leak, which is why the
 * setting is cited here rather than parsed and enforced.
 */
export function isRuntimeLoad(clause) {
  return !clause.trim().startsWith("type ");
}

/**
 * Every `@alfred/*` import in a source text, with whether it loads the module.
 *
 * The walk is over import *statements*, so a specifier that a comment, a quoted
 * string or a template literal merely mentions is not an import — which matters
 * more here than it looks, because a mentioned package would join the browser
 * surface and fail this check on its own legitimate server-side imports.
 *
 * One rule decides every import shape, and it is stated over clauses rather than
 * over shapes: a clause is erased only when the `type` keyword leads it, and every
 * other clause is a module load. A side-effect, dynamic or `require` form carries
 * no clause at all, so it loads — which is the right answer for all three. A
 * computed `import(variable)` is still invisible: the walk needs a literal in the
 * argument position, so there is nothing to read.
 */
function scanAlfredImports(source) {
  const imports = [];
  for (const entry of parseImports(source)) {
    const pkg = packageName(entry.specifier);
    if (!pkg) continue;
    imports.push({
      pkg,
      specifier: entry.specifier,
      line: entry.line,
      runtime: isRuntimeLoad(entry.clause),
    });
  }
  return imports;
}

/**
 * Forbidden runtime loads in one file, named the way the surface names it.
 *
 * Repo-relative, because that is the dialect every other function here speaks:
 * `browserSurface` hands back repo-relative paths and this takes them, so no call
 * site has to know that one half of the module wanted absolute ones.
 */
export function findViolations(root, file) {
  const source = readFileSync(join(root, file), "utf8");
  return scanAlfredImports(source)
    .filter((entry) => entry.runtime && FORBIDDEN_RUNTIME_PACKAGES.has(entry.pkg))
    .map(({ line, specifier }) => ({ line, specifier }));
}

/**
 * Whether every app has a declared relationship to the browser bundle.
 *
 * These are failures and never violations: nothing in the tree is wrong, the fence
 * simply does not know how wide it should be. Honest about what it buys — an app in
 * neither set cannot reach a green `pnpm check`, and a declared entry app that the
 * enumeration does not list cannot either, so the add-an-app and move-the-app events
 * are both caught. Neither forces the classification to be CORRECT: a browser app
 * filed under `NODE_ONLY_APPS` leaves the fence narrow, and the only argument against
 * that is the `index.html` corroboration, which an SSR browser app would not trip.
 */
function appDeclarationFailures(root, appDirs) {
  const failures = [];

  for (const dir of appDirs) {
    if (BROWSER_ENTRY_APPS.has(dir) || NODE_ONLY_APPS.has(dir)) continue;
    failures.push(
      `${dir} is a workspace under apps/ that neither BROWSER_ENTRY_APPS nor NODE_ONLY_APPS names, so nobody has declared whether its sources reach a browser bundle. Add it to one of the two sets in scripts/web-boundaries.mjs.`,
    );
  }

  const enumerated = new Set(appDirs);
  for (const dir of BROWSER_ENTRY_APPS) {
    if (enumerated.has(dir)) continue;
    failures.push(
      `BROWSER_ENTRY_APPS names ${dir}, which the workspace enumeration does not list, so the fence is seeded from a tree that is not there. Point BROWSER_ENTRY_APPS at the app's new directory.`,
    );
  }

  for (const dir of NODE_ONLY_APPS) {
    if (!existsSync(join(root, dir, BUNDLER_ENTRY_DOCUMENT))) continue;
    failures.push(
      `${dir} is listed in NODE_ONLY_APPS and holds an ${BUNDLER_ENTRY_DOCUMENT}, which is what a browser app's bundler entry looks like. Either it belongs in BROWSER_ENTRY_APPS, or the file does not belong there.`,
    );
  }

  return failures;
}

function sourceFilesUnder(root, dir) {
  // A pathspec whose parent directory is gone makes git print
  // `warning: could not open directory ...` onto this check's own stderr, and a gate
  // whose output opens with a raw git warning reads like a crash. A root that is not
  // there is reported by the caller in a sentence that says what to do about it.
  if (!existsSync(join(root, dir))) return [];
  return listGitSourceFiles([dir], root).filter((file) => SOURCE_FILE.test(file));
}

/**
 * The scan surface: the trees that reach the browser bundle, the files inside
 * them, and the structural problems that make the surface untrustworthy.
 *
 * The trees are the `src` of every app declared browser-bound plus, transitively,
 * the `src` of every workspace that some already-reachable file imports at runtime.
 * A forbidden package is never added as a root — an import of one is a violation
 * to report, not a tree to walk. Reachability is per-package, not per-module:
 * one runtime binding pulls the whole `src` into the fence, which is deliberately
 * conservative because a package that is browser-safe through one subpath and
 * server-bound through another has a boundary problem of its own.
 *
 * `failures` exists because every way this walk can resolve *nothing* looks
 * exactly like a clean tree from the outside, and the authorities that decide what
 * the surface holds each fail differently. `pnpm-workspace.yaml` says which
 * directories are workspaces, so a refused enumeration is carried through from
 * `listWorkspaces`; the two declaration sets say which apps the fence seeds from,
 * so an app nobody classified is reported; the filesystem says whether `<dir>/src`
 * exists, so a reached workspace that keeps no sources there is reported; and git
 * plus `SOURCE_FILE` say which files under a root are scannable, so a root that
 * resolves none — an empty directory left behind by a move, or a package written in
 * plain `.js` — is reported too, because being inside the surface is not being
 * scanned. All of them go red instead of passing vacuously.
 */
export function browserSurface(root) {
  const { workspaces, failures } = listWorkspaces(root);

  /** Workspace package name to its repo-relative directory, for the reachability walk. */
  const packageDirs = new Map();
  const appDirs = [];
  for (const workspace of workspaces) {
    if (workspace.name !== null) packageDirs.set(workspace.name, workspace.dir);
    if (workspace.group === "apps") appDirs.push(workspace.dir);
  }
  failures.push(...appDeclarationFailures(root, appDirs));

  const roots = [...BROWSER_ENTRY_APPS].map((app) => `${app}/src`).sort();
  const seen = new Set(roots);
  /** Why each derived root joined the surface, so an empty one can name its importer. */
  const reachedBy = new Map();

  /** Entry roots that are not there, so the walk below does not report them twice. */
  const missingRoots = new Set();
  for (const entryRoot of roots) {
    if (existsSync(join(root, entryRoot))) continue;
    missingRoots.add(entryRoot);
    failures.push(
      `the browser entry root ${entryRoot} does not exist, so the scan surface is derived from nothing.`,
    );
  }

  for (let index = 0; index < roots.length; index += 1) {
    for (const file of sourceFilesUnder(root, roots[index])) {
      const source = readFileSync(join(root, file), "utf8");
      for (const entry of scanAlfredImports(source)) {
        if (!entry.runtime) continue;
        if (FORBIDDEN_RUNTIME_PACKAGES.has(entry.pkg)) continue;

        const dir = packageDirs.get(entry.pkg);
        if (!dir) continue;
        const next = `${dir}/src`;
        if (seen.has(next)) continue;
        seen.add(next);

        if (!existsSync(join(root, next))) {
          failures.push(
            `${file} imports ${entry.pkg} at runtime, but ${dir} keeps no sources in src/, so the fence cannot scan it.`,
          );
          continue;
        }

        reachedBy.set(next, { file, pkg: entry.pkg });
        roots.push(next);
      }
    }
  }

  roots.sort();
  const files = [];
  for (const dir of roots) {
    if (missingRoots.has(dir)) continue;
    const scanned = sourceFilesUnder(root, dir);
    if (scanned.length === 0) {
      const reached = reachedBy.get(dir);
      failures.push(
        reached
          ? `${reached.file} imports ${reached.pkg} at runtime, but git lists no .ts or .tsx file under ${dir}, so the fence scans none of it.`
          : `git lists no .ts or .tsx file under ${dir}, so the fence scans none of it.`,
      );
      continue;
    }
    files.push(...scanned);
  }

  if (files.length === 0) {
    failures.push(
      `the scan resolved no source files under ${roots.join(", ")}; a check that reads nothing cannot report a violation.`,
    );
  }

  return { roots, files, failures };
}

/** The browser-reachable trees alone, repo-relative and sorted. */
export function browserRoots(root) {
  return browserSurface(root).roots;
}

/**
 * Drift between the forbidden list and the prose that restates it.
 *
 * The comparison is set equality over the backticked `@alfred/*` tokens inside
 * the marker pair, so the two sites stay free to word, order and punctuate the
 * rule differently — only the membership is checked.
 *
 * A site must hold exactly one pair. A second marked block — a worked example in
 * a fenced code block, or a second enumeration further down the file — would
 * otherwise read as gated while nothing compares it, which is the drift the
 * markers exist to stop.
 */
export function docListFailures(root) {
  const failures = [];

  for (const site of DOC_LIST_SITES) {
    const path = join(root, site);
    if (!existsSync(path)) {
      failures.push(`${site} is missing; it must restate the forbidden package list.`);
      continue;
    }

    const source = readFileSync(path, "utf8");
    const starts = source.split(DOC_MARKER_START).length - 1;
    const ends = source.split(DOC_MARKER_END).length - 1;
    if (starts !== 1 || ends !== 1) {
      failures.push(
        `${site} must hold exactly one ${DOC_MARKER_START} / ${DOC_MARKER_END} marker pair, but it holds ${starts} start and ${ends} end markers; only the first pair is ever compared.`,
      );
      continue;
    }

    const start = source.indexOf(DOC_MARKER_START);
    const end = source.indexOf(DOC_MARKER_END);
    if (end < start) {
      failures.push(`${site} closes the ${DOC_MARKER_END} marker before it opens the pair.`);
      continue;
    }

    const block = source.slice(start + DOC_MARKER_START.length, end);
    const listed = new Set(
      [...block.matchAll(/`(@alfred\/[a-z0-9-]+)`/g)].map((match) => match[1]),
    );

    for (const pkg of FORBIDDEN_RUNTIME_PACKAGES) {
      if (!listed.has(pkg)) failures.push(`${site} does not list ${pkg} as forbidden.`);
    }
    for (const pkg of listed) {
      if (!FORBIDDEN_RUNTIME_PACKAGES.has(pkg)) {
        failures.push(`${site} lists ${pkg} as forbidden, but it is not in the forbidden set.`);
      }
    }
  }

  return failures;
}
