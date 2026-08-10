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

export function packageName(specifier) {
  if (!specifier.startsWith("@alfred/")) return null;
  const [scope, pkg] = specifier.split("/");
  return pkg ? `${scope}/${pkg}` : null;
}

export function lineNumber(source, index) {
  return source.slice(0, index).split("\n").length;
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
 * Side-effect and dynamic imports carry no clause and always bind at runtime.
 * The scan is a regex over specifiers, so a computed `import(variable)` is
 * invisible to it.
 */
export function scanAlfredImports(source) {
  const imports = [];
  const staticImport = /\b(import|export)\s+([\s\S]*?)\s+from\s*["']([^"']+)["']/g;
  const sideEffectImport = /\bimport\s*["']([^"']+)["']/g;
  const dynamicImport = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;

  for (const match of source.matchAll(staticImport)) {
    const pkg = packageName(match[3] ?? "");
    if (!pkg) continue;
    imports.push({
      pkg,
      specifier: match[3] ?? "",
      line: lineNumber(source, match.index ?? 0),
      runtime: hasRuntimeBinding(match[2] ?? ""),
    });
  }

  for (const pattern of [sideEffectImport, dynamicImport]) {
    for (const match of source.matchAll(pattern)) {
      const pkg = packageName(match[1] ?? "");
      if (!pkg) continue;
      imports.push({
        pkg,
        specifier: match[1] ?? "",
        line: lineNumber(source, match.index ?? 0),
        runtime: true,
      });
    }
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
 * The trees that reach the browser bundle: the web app plus, transitively, the
 * `src` of every workspace package some already-reachable file imports at
 * runtime.
 *
 * A forbidden package is never added as a root — an import of one is a violation
 * to report, not a tree to walk. Reachability is per-package, not per-module:
 * one runtime binding pulls the whole `src` into the fence, which is deliberately
 * conservative because a package that is browser-safe through one subpath and
 * server-bound through another has a boundary problem of its own.
 */
export function browserRoots(root) {
  const packageDirs = workspacePackageDirs(root);
  const roots = [BROWSER_ENTRY_ROOT];
  const seen = new Set(roots);

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
        if (!existsSync(join(root, next))) continue;

        seen.add(next);
        roots.push(next);
      }
    }
  }

  return roots.sort();
}

/** Every source file inside the browser-reachable surface, repo-relative. */
export function browserSourceFiles(root) {
  return browserRoots(root).flatMap((dir) => sourceFilesUnder(root, dir));
}

/**
 * Drift between the forbidden list and the prose that restates it.
 *
 * The comparison is set equality over the backticked `@alfred/*` tokens inside
 * the marker pair, so the two sites stay free to word, order and punctuate the
 * rule differently — only the membership is checked.
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
    const start = source.indexOf(DOC_MARKER_START);
    const end = source.indexOf(DOC_MARKER_END);
    if (start === -1 || end === -1 || end < start) {
      failures.push(`${site} is missing the ${DOC_MARKER_START} / ${DOC_MARKER_END} marker pair.`);
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
