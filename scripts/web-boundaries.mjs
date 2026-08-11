// The browser boundary, stated once: which packages must never reach the browser
// bundle at runtime, and which trees actually reach that bundle.
//
// The second half used to be a constant (`apps/web/src`), which made the fence
// narrower than the rule it enforces — a new browser-bound package sat outside it
// by construction until somebody remembered to widen the walk. Here the surface is
// derived instead: start at the web app and follow every runtime `@alfred/*`
// binding into the workspace, so a package that joins the bundle joins the fence in
// the same commit.
//
// This module is pure. `scripts/check-web-boundaries.mjs` is the CLI that exits on
// it, and `scripts/web-boundaries.selftest.mjs` is its fixture suite.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { listGitSourceFiles } from "./git-source-files.mjs";
import { parseImports } from "./ts-imports.mjs";

/**
 * Packages a browser runtime file must not take a value binding on. `import type`
 * is allowed for every member: a type erases at build time, so it cannot ship the
 * package's Node-only dependencies into the bundle.
 */
export const FORBIDDEN_RUNTIME_PACKAGES = new Set([
  "@alfred/api",
  "@alfred/http",
  "@alfred/auth",
  "@alfred/db",
  "@alfred/env",
  "@alfred/ai",
]);

/** The tree the fence starts from. Everything else is derived from its imports. */
const BROWSER_ENTRY_ROOT = "apps/web/src";

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

export function hasRuntimeBinding(clause) {
  const trimmed = clause.trim();
  if (trimmed.startsWith("type ")) return false;

  const namedOnly = trimmed.match(/^\{([\s\S]*)\}$/);
  if (!namedOnly) return true;

  const specifiers = namedOnly[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return specifiers.some((specifier) => !specifier.startsWith("type "));
}

/**
 * Every `@alfred/*` import in a source text, with whether it binds a value.
 *
 * The walk is over import *statements*, so a specifier that a comment, a quoted
 * string or a template literal merely mentions is not a binding — which matters
 * more here than it looks, because a mentioned package would join the browser
 * surface and fail this check on its own legitimate server-side imports.
 *
 * One rule decides all four import shapes. A side-effect, dynamic or `require`
 * form carries no clause, and an empty clause is a runtime binding, which is the
 * right answer for all three. A computed `import(variable)` is still invisible:
 * the walk needs a literal in the argument position, so there is nothing to read.
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
      runtime: hasRuntimeBinding(entry.clause),
    });
  }
  return imports;
}

/** Forbidden runtime bindings in one file, by absolute path. */
export function findViolations(file) {
  const source = readFileSync(file, "utf8");
  return scanAlfredImports(source)
    .filter((entry) => entry.runtime && FORBIDDEN_RUNTIME_PACKAGES.has(entry.pkg))
    .map(({ line, specifier }) => ({ line, specifier }));
}

/** Workspace package name to its repo-relative directory. */
function workspacePackageDirs(root) {
  const dirs = new Map();
  const packagesDir = join(root, "packages");
  if (!existsSync(packagesDir)) return dirs;

  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = join(packagesDir, entry.name, "package.json");
    if (!existsSync(manifest)) continue;
    const { name } = JSON.parse(readFileSync(manifest, "utf8"));
    if (typeof name === "string") dirs.set(name, `packages/${entry.name}`);
  }
  return dirs;
}

function sourceFilesUnder(root, dir) {
  return listGitSourceFiles([dir], root).filter((file) => SOURCE_FILE.test(file));
}

/**
 * The scan surface: the trees that reach the browser bundle, the files inside
 * them, and the structural problems that make the surface untrustworthy.
 *
 * The trees are the web app plus, transitively, the `src` of every workspace
 * package under `packages/` that some already-reachable file imports at runtime.
 * A forbidden package is never added as a root — an import of one is a violation
 * to report, not a tree to walk. Reachability is per-package, not per-module:
 * one runtime binding pulls the whole `src` into the fence, which is deliberately
 * conservative because a package that is browser-safe through one subpath and
 * server-bound through another has a boundary problem of its own.
 *
 * `failures` exists because every way this walk can resolve *nothing* looks
 * exactly like a clean tree from the outside. There are three, and they are
 * three because three different authorities decide what a root contains: the
 * filesystem says whether `<pkg>/src` exists, git says which files under it are
 * listed, and `SOURCE_FILE` says which of those are TypeScript. So a reached
 * package that keeps no sources in `src/` is reported; a root whose `src/`
 * resolves no scannable file — an empty directory left behind by a move, or a
 * package written in plain `.js` — is reported too, because being inside the
 * surface is not being scanned; and the seed root is a constant, so a web app
 * that moves leaves the fence scanning zero files. All three go red instead of
 * passing vacuously.
 */
export function browserSurface(root) {
  const packageDirs = workspacePackageDirs(root);
  const failures = [];
  const roots = [BROWSER_ENTRY_ROOT];
  const seen = new Set(roots);
  /** Why each derived root joined the surface, so an empty one can name its importer. */
  const reachedBy = new Map();

  if (!existsSync(join(root, BROWSER_ENTRY_ROOT))) {
    failures.push(
      `the browser entry root ${BROWSER_ENTRY_ROOT} does not exist, so the scan surface is derived from nothing.`,
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
