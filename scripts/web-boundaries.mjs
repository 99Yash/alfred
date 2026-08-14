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

/**
 * Apps whose sources reach a browser bundle. The fence seeds from these.
 *
 * Exported because `scripts/web-bundle-graph.mjs` builds exactly these apps to record
 * the real module graph. One declaration, two fences: an app declared here joins both
 * in the same commit, which is the property this set exists for.
 */
export const BROWSER_ENTRY_APPS = new Set(["apps/web"]);

/** Apps that are Node programs. Listed so a NEW app cannot be silently either. */
const NODE_ONLY_APPS = new Set(["apps/server"]);

/** A browser bundler's entry document, used only to corroborate a NODE_ONLY claim. */
const BUNDLER_ENTRY_DOCUMENT = "index.html";

/** Prose sites that enumerate the forbidden list and must not drift from it. */
const DOC_LIST_SITES = ["docs/reference/architecture.md", "apps/web/AGENTS.md"];

/**
 * The region kinds a prose site marks, and what each region's tokens must satisfy.
 *
 * The forbidden region restates the list, so it is compared by set EQUALITY. The
 * browser-safe region is compared by DISJOINTNESS instead, because there is no
 * source-of-truth allowed set to equal: the same list also names `@elysiajs/eden`
 * and `better-auth/react`, which are not `@alfred/*` packages at all.
 */
const DOC_REGION_KINDS = [
  { name: "forbidden-runtime-packages", predicate: "equals" },
  { name: "browser-safe-packages", predicate: "disjoint" },
];

const DOC_REGION_MARKERS = new Map(
  DOC_REGION_KINDS.map((kind) => [
    kind.name,
    { start: `<!-- ${kind.name}:start -->`, end: `<!-- ${kind.name}:end -->` },
  ]),
);

/** A backticked `@alfred/*` token on its own. A longer code span is not one. */
const DOC_PACKAGE_TOKEN = /`(@alfred\/[a-z0-9-]+)`/g;

/** A line whose whole content is one region marker. */
const DOC_MARKER_LINE = /^\s*<!--\s*[a-z-]+:(?:start|end)\s*-->\s*$/;

/** A markdown list item, at any nesting depth. */
const DOC_LIST_ITEM_LINE = /^\s*[-*+]\s/;

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

/** The bare `@alfred/*` tokens on one line. A longer code span holds none. */
function packageTokens(line) {
  return [...line.matchAll(DOC_PACKAGE_TOKEN)].map((match) => match[1]);
}

/**
 * One region of one kind at one site, or `null` with its failures recorded.
 *
 * A region is a range of WHOLE LINES: the `:start` marker ends its line and the
 * `:end` marker opens its line, so every line is either wholly inside the region
 * or wholly outside it. That is what makes per-line containment definable at all
 * — an inline pair leaves a bullet half inside and half outside.
 */
function locateRegion(site, kind, lines, failures) {
  // `Map.get` is typed as partial, but this one is not: `DOC_REGION_MARKERS` is built
  // from `DOC_REGION_KINDS` and every call site passes a `kind` drawn from that same
  // list, so the miss is unreachable by construction. The assertion records that
  // warrant. A runtime guard here would be a branch no input can reach and no drive
  // can cover — which is a worse thing to add to a checker than a stated assumption.
  const { start: startMarker, end: endMarker } = /** @type {{start: string, end: string}} */ (
    DOC_REGION_MARKERS.get(kind.name)
  );
  const source = lines.join("\n");

  const starts = source.split(startMarker).length - 1;
  const ends = source.split(endMarker).length - 1;
  if (starts !== 1 || ends !== 1) {
    failures.push(
      `${site} must hold exactly one ${startMarker} / ${endMarker} marker pair, but it holds ${starts} start and ${ends} end markers; only the first pair is ever compared.`,
    );
    return null;
  }

  if (source.indexOf(endMarker) < source.indexOf(startMarker)) {
    failures.push(`${site} closes the ${endMarker} marker before it opens the pair.`);
    return null;
  }

  const startLine = lines.findIndex((line) => line.includes(startMarker));
  const endLine = lines.findIndex((line) => line.includes(endMarker));

  const trailer = lines[startLine].slice(
    lines[startLine].indexOf(startMarker) + startMarker.length,
  );
  const leader = lines[endLine].slice(0, lines[endLine].indexOf(endMarker));
  if (trailer.trim() !== "") {
    failures.push(
      `${site}:${startLine + 1} puts text after ${startMarker}; the marker must end its line, or the region is a sub-span of a line rather than whole lines.`,
    );
  }
  if (leader.trim() !== "") {
    failures.push(
      `${site}:${endLine + 1} puts text before ${endMarker}; the marker must open its line, or the region is a sub-span of a line rather than whole lines.`,
    );
  }
  if (trailer.trim() !== "" || leader.trim() !== "") return null;

  const listed = new Set(lines.slice(startLine + 1, endLine).flatMap(packageTokens));

  if (kind.predicate === "equals") {
    for (const pkg of FORBIDDEN_RUNTIME_PACKAGES) {
      if (!listed.has(pkg)) failures.push(`${site} does not list ${pkg} as forbidden.`);
    }
    for (const pkg of listed) {
      if (!FORBIDDEN_RUNTIME_PACKAGES.has(pkg)) {
        failures.push(`${site} lists ${pkg} as forbidden, but it is not in the forbidden set.`);
      }
    }
  } else {
    for (const pkg of listed) {
      if (FORBIDDEN_RUNTIME_PACKAGES.has(pkg)) {
        failures.push(
          `${site} names ${pkg} in its ${kind.name} region, but it is a forbidden runtime package.`,
        );
      }
    }
  }

  return { name: kind.name, startLine, endLine };
}

/** Lines that belong to the markdown list a region sits in, region included. */
function listBlockLines(lines, region) {
  const holds = (index) =>
    lines[index].trim() === "" ||
    DOC_LIST_ITEM_LINE.test(lines[index]) ||
    DOC_MARKER_LINE.test(lines[index]);

  const block = new Set();
  for (let index = region.startLine; index <= region.endLine; index += 1) block.add(index);
  for (let index = region.startLine - 1; index >= 0 && holds(index); index -= 1) block.add(index);
  for (let index = region.endLine + 1; index < lines.length && holds(index); index += 1) {
    block.add(index);
  }
  return block;
}

/**
 * Bare tokens that sit in the list a region marks, but in no region.
 *
 * A blank line does not end the list: the gesture this rule exists to catch is a
 * sibling bullet added after the marked one, and an author writes that with or
 * without a blank line between. A paragraph, a heading or a fence does end it —
 * `architecture.md` names `@alfred/db` and `@alfred/env` correctly in a paragraph
 * about `apps/server`, which is why the scope is the list rather than the section.
 */
function containmentFailures(site, lines, regions) {
  const failures = [];
  const block = new Set();
  for (const region of regions) {
    for (const index of listBlockLines(lines, region)) block.add(index);
  }

  for (const index of [...block].sort((left, right) => left - right)) {
    if (regions.some((region) => index > region.startLine && index < region.endLine)) continue;
    for (const pkg of packageTokens(lines[index])) {
      failures.push(
        `${site}:${index + 1} names ${pkg} in the same list as a marked region but outside every region; move it into the region it belongs to.`,
      );
    }
  }
  return failures;
}

/**
 * Drift between the forbidden list and the prose that restates it.
 *
 * Each site marks two regions. The `forbidden-runtime-packages` region restates
 * the list and is compared by set EQUALITY over the bare backticked `@alfred/*`
 * tokens inside it; the `browser-safe-packages` region names what browser code
 * may import and is compared by DISJOINTNESS from the same set. So both sites
 * stay free to word, order and punctuate the rule differently — only membership
 * is checked — and prose that declares a forbidden package browser-safe fails.
 *
 * A token is a backticked package name ON ITS OWN. A longer code span such as
 * `` `import type { App } from '@alfred/http'` `` is not a token, which is what
 * lets the allowed list keep its type-only example inside the browser-safe region.
 *
 * Three structural rules make those comparisons mean what they read as:
 *
 * - A site holds exactly one pair PER KIND. A second same-kind block — a worked
 *   example in a fenced code block, or a second enumeration further down the file
 *   — would read as gated while nothing compares it.
 * - A region spans WHOLE LINES. An inline pair gates a sub-span of one line, so
 *   ordinary edits to the rest of that line ship unchecked.
 * - Every bare token in the markdown list that holds a region sits INSIDE a
 *   region. Without this, a sibling bullet names a package and nothing rules on it.
 */
export function docListFailures(root) {
  const failures = [];

  for (const site of DOC_LIST_SITES) {
    const path = join(root, site);
    if (!existsSync(path)) {
      failures.push(`${site} is missing; it must restate the forbidden package list.`);
      continue;
    }

    const lines = readFileSync(path, "utf8").split("\n");
    const regions = [];
    for (const kind of DOC_REGION_KINDS) {
      const region = locateRegion(site, kind, lines, failures);
      if (region) regions.push(region);
    }

    failures.push(...containmentFailures(site, lines, regions));
  }

  return failures;
}
