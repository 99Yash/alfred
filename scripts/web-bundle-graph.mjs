// The half of the browser boundary that only a resolver can answer: what is
// actually IN the bundle.
//
// `web-boundaries.mjs` reads source text, so it rules on specifiers a browser file
// writes down. That is the wrong instrument for one shape, and it is the shape that
// matters most: a browser-safe workspace package that declares a Node-only npm
// package itself. `@alfred/contracts` growing a `pg` dependency writes no forbidden
// specifier into any browser file, resolves cleanly, bundles, and fails only in a
// browser at runtime. No amount of source scanning sees it, because the fact lives
// in a manifest several hops down the resolution graph.
//
// So this module asks vite for `apps/web`'s real rollup module graph and rules on
// its membership. Three rules, and the module says out loud which tier each buys:
//
//   R1  no graph module belongs to a package that a Node-only workspace declares.
//       Tier 1 — the forbid set is DERIVED from the manifests, so a new server
//       dependency is fenced in the commit that adds it and nobody has to remember
//       a list.
//   R2  the browser-externalized-builtin stub is not in the graph. Tier 3 — it
//       rests on two vite internals that no contract owns (see BUILTIN_STUB).
//   R3  every workspace TypeScript module in the graph is a file the source fence
//       scans. Tier 1 — and it is the only mechanism in this repo that could ever
//       detect a hole in that fence.
//
// The three rules partition the id space rather than sampling it. `classifyModuleId`
// answers with one of five kinds and every kind has an owner: `virtual` is ignored
// (rollup's own helpers and commonjs shims are not repo code), `builtin-stub` is R2,
// `npm` is R1, `workspace` is R3, and `foreign` — an absolute path that is neither
// inside the repo nor inside a `node_modules` — is reported rather than dropped,
// because a module the check cannot classify is a module it is not ruling on.
//
// Every rule here is an emptiness assertion, which is the failure mode this campaign
// has paid for three times: all three pass over an empty graph. So the judgment also
// carries its own floors — the recorder's `buildEnd` must be observed to have run,
// the browser entry's own module must be present, and the workspace-module count must
// be non-zero. A vite bridge that loads the wrong config satisfies none of them.
//
// `recordBundleGraph` is the only impure function. Everything else is pure over a
// recorded graph, which is what makes the id-normalisation traps testable at all:
// `scripts/web-bundle-graph.selftest.mjs` drives them with synthetic ids, and
// `scripts/check-web-bundle-graph.mjs` is the CLI that runs the suite and exits.

import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  BROWSER_ENTRY_APPS,
  FORBIDDEN_RUNTIME_PACKAGES,
  browserSurface,
} from "./web-boundaries.mjs";
import { listWorkspaces } from "./workspaces.mjs";

/** The NUL a rollup virtual module id is prefixed with, written so it is visible. */
const NUL = "\u0000";

/**
 * npm packages a Node-only workspace declares that a browser module may still load.
 *
 * This is a classification, not a suppression list: nothing here excuses a module or
 * a file, and each entry is a claim that the package itself is genuinely shared. The
 * list is DECLARED rather than computed as `⋃nodeSide − ⋃browserSide`, because that
 * subtraction is wrong in both directions. It would drop `@alfred/api` — `apps/web`
 * declares it for a type-only `import type { App }` — which is the single most
 * forbidden package in the repo. And it would excuse `react` on the strength of
 * `packages/mailer`, which declares it for `@react-email/components`, a server-side
 * email renderer with nothing to do with the browser. Declared, that entry carries
 * its reason on its own line.
 *
 * It fails closed. A Node-only dependency added to a browser-bound workspace lands in
 * the forbid set, and the check stays red until somebody removes it or writes one
 * line here.
 */
export const BROWSER_SAFE_NPM_PACKAGES = new Map([
  ["react", "the browser renders with it; packages/mailer declares it for @react-email/components"],
  ["react-dom", "the browser renders with it; packages/mailer declares it for the same reason"],
  ["zod", "isomorphic schema library, imported by @alfred/contracts on both sides"],
  ["better-auth", "ships a browser client entry (better-auth/react) alongside its server half"],
]);

/**
 * The id vite resolves EVERY externalized Node builtin to, in a production build.
 *
 * This is the verdict channel for R2, and it is a resolved-id constant rather than
 * prose. Two measured facts make it the only available verdict, both verified against
 * vite 6.4.3 by executing planted leaks and by reading the resolver:
 *
 * - Scanning module ids for builtin NAMES finds nothing, ever. Injecting
 *   `import "node:fs"; import "node:crypto"` into a browser entry grew the graph by
 *   ONE module, not two: both collapse onto this one shared stub, whose id carries no
 *   `node:` prefix and no builtin name. The `:${id}`-suffixed form of it is dev-only.
 * - `isExternal` is structurally dead here, not merely empty. `resolve.builtins` is
 *   hardcoded to `[]` for the client consumer, so the `{ external: true }` branch is
 *   unreachable and a future run finding "zero externals" will keep meaning nothing.
 *
 * The stub's `.importers` names the browser files that leaked, which is why the
 * verdict can rest here and only the NAMING needs the warning below.
 */
const BUILTIN_STUB = "__vite-browser-external";

/**
 * vite's own sentence when it externalizes a builtin. The enrichment channel for R2.
 *
 * The builtin's name exists nowhere else: the stub id does not carry it and the
 * warning object has no populated `id` or `importer` field — both are interpolated
 * into the message text. Verified against **vite 6.4.3**; the next vite major is the
 * deadline on this pattern.
 *
 * Splitting the channels is the point. A reword leaves the verdict armed and only
 * makes it less specific. If the verdict rested on this regex, a reword would turn
 * the rule green and silent.
 *
 * One matcher covers both spellings: vite's `nodeLikeBuiltins` is
 * `builtinModules.filter((id) => !id.includes(":"))` plus regexes for `node:`, `npm:`
 * and `bun:`, so `import "path"` and `import "node:path"` reach the same branch and
 * produce byte-identical warnings.
 */
const BUILTIN_WARNING =
  /Module "([^"]+)" has been externalized for browser compatibility, imported by "([^"]+)"/g;

/** The module every browser build must contain, so a vacuous graph cannot pass. */
const ANCHOR_MODULE = "src/main.tsx";

/** The config file a browser app's build is driven from. */
const VITE_CONFIG = "vite.config.ts";

/** The files R3 rules on. The source fence scans exactly these two extensions. */
const SOURCE_FILE = /\.(ts|tsx)$/;

/** The dependency field a manifest declares its runtime packages in. */
const DEPENDENCIES = "dependencies";

/**
 * @typedef {object} RecordedGraph
 * @property {string} root absolute path the ids were recorded against
 * @property {Map<string, string[]>} importers module id to the ids that import it
 * @property {string[]} entries the ids rollup treated as entry points
 * @property {string[]} warnings every warning message the build emitted, verbatim
 * @property {boolean} completed whether the recorder's own `buildEnd` hook ran
 */

/**
 * @typedef {object} Violation
 * @property {"forbidden-package" | "node-builtin" | "unscanned-module" | "unclassified-module" | "vacuous-graph"} rule
 * @property {string} subject the module id, package name or floor the violation is about
 * @property {string} message one sentence, ready to print
 * @property {string[]} chain importer chain from a browser entry, entry first, described
 */

/**
 * An empty recorded graph, so a failed bridge still hands back the documented shape.
 *
 * @returns {RecordedGraph}
 */
function emptyGraph(root) {
  return { root, importers: new Map(), entries: [], warnings: [], completed: false };
}

/**
 * The npm and workspace packages no browser module may belong to.
 *
 * Derived, in three steps, from the two authorities that already own the question:
 *
 *   1. the union of `dependencies` over every workspace the browser fence does NOT
 *      reach — `pnpm-workspace.yaml` says what the workspaces are and
 *      `browserSurface` says which ones the bundle reaches, so neither half is
 *      restated here;
 *   2. minus `BROWSER_SAFE_NPM_PACKAGES`, the declared exceptions;
 *   3. union `FORBIDDEN_RUNTIME_PACKAGES`, the six names the source fence already
 *      forbids.
 *
 * Step 3 is not decoration. Without it the subtraction in step 2 excuses
 * `@alfred/api`, because `apps/web` legitimately declares it for a type-only import
 * — a subtraction-only rule ships a check that cannot see the most forbidden package
 * in the repo.
 *
 * `devDependencies` are never read. A dev dependency is a build-time tool; it is the
 * runtime `dependencies` of a workspace that say what its modules can drag in.
 *
 * @returns {{ packages: Map<string, string>, failures: string[] }} each forbidden
 *   package mapped to the one-line reason it is forbidden, plus the refusals that
 *   make the set untrustworthy. A caller that reports zero violations without
 *   reporting these has passed over a set derived from less than the whole tree.
 */
export function nodeOnlyPackages(root) {
  const failures = [];

  const { workspaces, failures: workspaceFailures } = listWorkspaces(root);
  failures.push(...workspaceFailures);

  const { roots, failures: surfaceFailures } = browserSurface(root);
  failures.push(...surfaceFailures);

  for (const [pkg] of BROWSER_SAFE_NPM_PACKAGES) {
    if (!FORBIDDEN_RUNTIME_PACKAGES.has(pkg)) continue;
    failures.push(
      `BROWSER_SAFE_NPM_PACKAGES declares ${pkg} browser-safe while FORBIDDEN_RUNTIME_PACKAGES forbids it. The two declarations contradict each other; the forbid set wins, so the exception reads as live and does nothing.`,
    );
  }

  // A root is `<dir>/src`, which is the dialect `browserSurface` speaks. The
  // workspace DIRECTORY is what a manifest sits in, so the roots are mapped back
  // rather than the workspaces mapped forward: a reached workspace whose sources are
  // missing has no root at all, and reading it as Node-only is the safe direction.
  const browserReached = new Set(roots.map((dir) => dir.replace(/\/src$/, "")));

  /** Every dependency the Node side declares, with the workspace that declared it. */
  const declared = new Map();
  for (const workspace of workspaces) {
    if (browserReached.has(workspace.dir)) continue;

    let dependencies;
    try {
      const parsed = JSON.parse(readFileSync(join(root, workspace.manifest), "utf8"));
      dependencies = parsed?.[DEPENDENCIES];
    } catch (error) {
      failures.push(
        `${workspace.manifest} is not readable as JSON (${error instanceof Error ? error.message : String(error)}), so the packages it declares are missing from the forbid set.`,
      );
      continue;
    }

    if (dependencies === undefined) continue;
    if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) {
      failures.push(
        `${workspace.manifest} has a "${DEPENDENCIES}" field that is not an object, so the packages it declares cannot be read into the forbid set.`,
      );
      continue;
    }

    for (const pkg of Object.keys(dependencies)) {
      if (!declared.has(pkg)) declared.set(pkg, workspace.dir);
    }
  }

  for (const [pkg] of BROWSER_SAFE_NPM_PACKAGES) {
    if (declared.has(pkg)) continue;
    failures.push(
      `BROWSER_SAFE_NPM_PACKAGES names ${pkg}, which no Node-only workspace declares as a dependency, so the exception excuses nothing. Delete the line.`,
    );
  }

  /** @type {Map<string, string>} */
  const packages = new Map();
  for (const [pkg, dir] of declared) {
    if (BROWSER_SAFE_NPM_PACKAGES.has(pkg)) continue;
    packages.set(pkg, `${dir} declares it as a dependency and the browser fence does not reach ${dir}`);
  }
  for (const pkg of FORBIDDEN_RUNTIME_PACKAGES) {
    packages.set(pkg, "FORBIDDEN_RUNTIME_PACKAGES in scripts/web-boundaries.mjs forbids it");
  }

  return { packages, failures };
}

/** A path with its rollup query suffix removed, at the FIRST `?`. */
function stripQuery(id) {
  const query = id.indexOf("?");
  return query === -1 ? id : id.slice(0, query);
}

/** The real path, or the path itself when it does not resolve. Never throws. */
function realPathOrSelf(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The npm package a path belongs to, keyed on its LAST `node_modules` segment. */
function npmPackageOf(path) {
  const marker = `${sep}node_modules${sep}`;
  const last = path.lastIndexOf(marker);
  if (last === -1) return null;

  const segments = path.slice(last + marker.length).split(sep);
  const [first, second] = segments;
  if (first === undefined || first === "") return null;
  if (!first.startsWith("@")) return first;
  return second === undefined || second === "" ? null : `${first}/${second}`;
}

/** A path's repo-relative form with `/` separators, or `null` when it is outside. */
function insideRoot(root, path) {
  const rel = relative(realPathOrSelf(root), path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/**
 * One module id, normalised and classified.
 *
 * Four normalisation facts, all measured on the real graph and none of them
 * guessable. A checker that gets any one of them wrong mis-files real modules while
 * still reading like it works:
 *
 * 1. **Test for a NUL ANYWHERE in the id, not just at its head.** 233 of 4180 ids
 *    contain a `\0`, and one form is written to look absolute:
 *    `\0/Users/…/react/jsx-runtime.js?commonjs-es-import`. That form is a red
 *    herring — on posix a string starting with `\0` does not start with `/`, so
 *    `path.isAbsolute` rejects it either way, and the fixtures proved that by
 *    driving the mutation. The test that is load-bearing is `includes` over
 *    `startsWith`: an id whose NUL sits after an absolute prefix classifies as a
 *    workspace file whose name carries a NUL, and R3 then reports a file that does
 *    not exist as a hole in the source fence.
 * 2. **Strip at the first `?`.** 258 ids carry a query, in four flavours: 28
 *    `?tsr-split=component` route ids from the TanStack router plugin's
 *    `autoCodeSplitting`, and three `?commonjs-*` forms from rollup's commonjs
 *    plugin. Each split route appears TWICE, bare and suffixed, so a checker that
 *    keeps the suffix both mis-classifies 28 real route files and double-counts them.
 * 3. **Realpath before reading the `node_modules` segment.** Workspace modules arrive
 *    as real paths today (`resolve.preserveSymlinks` defaults to `false`, and 0 of
 *    425 needed the fallback), so this line is a no-op — and it is one config flag
 *    away from being load-bearing. Without it, flipping that flag would silently
 *    reclassify the entire workspace surface as third-party and disarm R3.
 * 4. **The LAST `node_modules` segment wins.** pnpm's store paths nest
 *    (`…/node_modules/.pnpm/react@19/node_modules/react/index.js`), so the first
 *    segment names the store layout rather than the package.
 *
 * @returns {{ kind: "virtual" | "builtin-stub" | "npm" | "workspace" | "foreign", package: string | null, file: string | null }}
 */
export function classifyModuleId(root, id) {
  if (id.includes(NUL)) return { kind: "virtual", package: null, file: null };

  const bare = stripQuery(id);
  if (bare === BUILTIN_STUB) return { kind: "builtin-stub", package: null, file: null };
  if (!isAbsolute(bare)) return { kind: "virtual", package: null, file: null };

  const real = realPathOrSelf(bare);

  const pkg = npmPackageOf(real);
  if (pkg !== null) return { kind: "npm", package: pkg, file: null };

  const file = insideRoot(root, real);
  if (file !== null) return { kind: "workspace", package: null, file };

  return { kind: "foreign", package: null, file: null };
}

/**
 * The shortest importer path from a browser entry to `id`, entry first.
 *
 * This earns its place because `getModuleInfo(id).importers` gives exactly ONE hop,
 * and the shape this whole module exists for is a package several hops down through a
 * subpath condition. A violation reported without the chain back to a browser entry
 * is a puzzle rather than a diagnosis.
 *
 * Breadth-first, so the path is the shortest one. A cycle terminates on the visited
 * set, and a graph whose importers do not reach an entry hands back the deepest path
 * found rather than nothing — a partial chain still names files to look at.
 */
export function importerChain(graph, id) {
  if (!graph.importers.has(id)) return [];

  const entries = new Set(graph.entries);
  const seen = new Set([id]);
  let deepest = [id];
  let frontier = [[id]];

  while (frontier.length > 0) {
    /** @type {string[][]} */
    const next = [];
    for (const path of frontier) {
      const head = path[0];
      if (head === undefined) continue;
      const importers = graph.importers.get(head) ?? [];
      if (entries.has(head) || importers.length === 0) return path;
      for (const importer of importers) {
        if (seen.has(importer)) continue;
        seen.add(importer);
        const step = [importer, ...path];
        if (step.length > deepest.length) deepest = step;
        next.push(step);
      }
    }
    frontier = next;
  }

  return deepest;
}

/** An id in the shortest form a reader can act on: a repo path, or a package name. */
function describeModuleId(root, id) {
  const info = classifyModuleId(root, id);
  if (info.file !== null) return info.file;
  if (info.package !== null) return `${info.package} (npm)`;
  return id;
}

/** The builtins the build named, from the one channel that carries their names. */
function warnedBuiltins(graph) {
  const named = new Map();
  for (const warning of graph.warnings) {
    for (const match of warning.matchAll(BUILTIN_WARNING)) {
      const [, builtin, importer] = match;
      if (builtin === undefined || importer === undefined) continue;
      const importers = named.get(builtin) ?? [];
      importers.push(describeModuleId(graph.root, importer));
      named.set(builtin, importers);
    }
  }
  return named;
}

/**
 * Every violation in a RECORDED graph. Pure over its argument.
 *
 * Ordered so the floors come first: a caller that prints this list reads why the
 * graph is untrustworthy before it reads anything derived from it.
 *
 * @param {RecordedGraph} graph
 * @param {{ forbidden: Map<string, string>, surface: Set<string> }} rules the derived
 *   forbid set with its reasons, and the files the source fence scans
 * @returns {Violation[]}
 */
export function bundleViolations(graph, { forbidden, surface }) {
  /** @type {Violation[]} */
  const floors = [];
  /** @type {Violation[]} */
  const violations = [];

  const chainOf = (id) => importerChain(graph, id).map((step) => describeModuleId(graph.root, step));

  const builtins = warnedBuiltins(graph);
  let workspaceModules = 0;
  let anchors = 0;

  for (const id of graph.importers.keys()) {
    const info = classifyModuleId(graph.root, id);

    if (info.kind === "virtual") continue;

    if (info.kind === "builtin-stub") {
      const named = [...builtins.keys()].sort();
      violations.push({
        rule: "node-builtin",
        subject: id,
        message: `a Node builtin reached the browser bundle: vite externalized ${named.length > 0 ? named.join(", ") : "one or more builtins it did not name"} onto the ${BUILTIN_STUB} stub. Browser code cannot load a Node builtin, so this fails at runtime rather than at build time.`,
        chain: chainOf(id),
      });
      continue;
    }

    if (info.kind === "npm") {
      const reason = info.package === null ? undefined : forbidden.get(info.package);
      if (reason === undefined) continue;
      violations.push({
        rule: "forbidden-package",
        subject: /** @type {string} */ (info.package),
        message: `the browser bundle contains ${info.package}, which is Node-only: ${reason}. Either the package is browser-safe, in which case declare it in BROWSER_SAFE_NPM_PACKAGES in scripts/web-bundle-graph.mjs with the reason, or a browser-reachable workspace should not depend on it.`,
        chain: chainOf(id),
      });
      continue;
    }

    if (info.kind === "workspace") {
      workspaceModules += 1;
      const file = /** @type {string} */ (info.file);
      if (file.endsWith(`/${ANCHOR_MODULE}`)) anchors += 1;
      // R3 rules on the two extensions the source fence scans, and only those. A
      // workspace `.css`, `.svg` or `index.html` in the graph is a real bundle
      // member that the fence never claimed to cover, so demanding it be in the
      // fence's file list would report the fence's own scope as a violation.
      if (!SOURCE_FILE.test(file)) continue;
      if (surface.has(file)) continue;
      violations.push({
        rule: "unscanned-module",
        subject: file,
        message: `${file} is in the browser bundle and the source fence does not scan it, so nothing rules on the packages it imports. This is a hole in browserSurface() in scripts/web-boundaries.mjs, not in this file: widen the surface so the fence reaches it.`,
        chain: chainOf(id),
      });
      continue;
    }

    violations.push({
      rule: "unclassified-module",
      subject: id,
      message: `${id} is an absolute path that is neither inside this repository nor inside a node_modules directory, so no rule here knows what it is. A module the check cannot classify is a module it is not ruling on.`,
      chain: chainOf(id),
    });
  }

  // The floors. Every rule above is an emptiness assertion, so all of them pass over
  // a graph that recorded nothing — and a build that throws, a bridge that loaded the
  // wrong config and a clean tree are indistinguishable from the outside without
  // these three.
  if (!graph.completed) {
    floors.push({
      rule: "vacuous-graph",
      subject: "buildEnd",
      message:
        "the recorder's buildEnd hook never ran, so the build did not finish and the graph below is whatever was parsed before it stopped. An unresolvable import aborts before buildEnd, so this is what a genuinely broken bundle looks like here.",
      chain: [],
    });
  }
  if (workspaceModules === 0) {
    floors.push({
      rule: "vacuous-graph",
      subject: "workspace modules",
      message:
        "the recorded graph holds no workspace module at all, so every rule below passed over nothing. A vite bridge pointed at the wrong root or the wrong config looks exactly like this.",
      chain: [],
    });
  }
  if (anchors === 0) {
    floors.push({
      rule: "vacuous-graph",
      subject: ANCHOR_MODULE,
      message: `no browser app's ${ANCHOR_MODULE} is in the recorded graph, so the build that produced it did not start from a browser entry.`,
      chain: [],
    });
  }

  return [...floors, ...violations].sort(
    (left, right) => left.rule.localeCompare(right.rule) || left.subject.localeCompare(right.subject),
  );
}

/** The workspace TypeScript files the graph holds, repo-relative. */
export function graphWorkspaceFiles(graph) {
  const files = new Set();
  for (const id of graph.importers.keys()) {
    const info = classifyModuleId(graph.root, id);
    if (info.kind !== "workspace" || info.file === null) continue;
    if (!SOURCE_FILE.test(info.file)) continue;
    files.add(info.file);
  }
  return files;
}

/** vite's `build`, resolved from the app that depends on it rather than from here. */
async function loadVite(root, app, failures) {
  // The repo root declares no `vite`, so `import("vite")` from `scripts/` is
  // ERR_MODULE_NOT_FOUND. Resolving from the app's own manifest is also the honest
  // reading: the version this check rules with is the version the app builds with.
  try {
    const resolveFrom = createRequire(join(root, app, "package.json"));
    const entry = resolveFrom.resolve("vite");
    return await import(pathToFileURL(entry).href);
  } catch (error) {
    failures.push(
      `vite could not be resolved from ${app} (${error instanceof Error ? error.message : String(error)}), so no module graph could be recorded.`,
    );
    return null;
  }
}

/**
 * IMPURE: runs a real vite build per declared browser app and records its graph.
 *
 * `write: false` keeps the build out of the tree; `minify` and
 * `reportCompressedSize` are off because nothing here reads the output bytes. The
 * config file is the app's own, transpiled by vite itself, so the graph this rules on
 * is the graph the deploy builds.
 *
 * A build that throws, an app with no config, and a missing vite are all reported as
 * `failures`. None of them is ever a clean result — that is the whole reason this
 * function is split from `bundleViolations`.
 *
 * @returns {Promise<{ graph: RecordedGraph, seconds: number, failures: string[] }>}
 */
export async function recordBundleGraph(root) {
  const failures = [];
  const graph = emptyGraph(root);

  const apps = [...BROWSER_ENTRY_APPS].sort();
  if (apps.length === 0) {
    failures.push(
      "BROWSER_ENTRY_APPS names no app, so there is no browser bundle to record a graph for.",
    );
    return { graph, seconds: 0, failures };
  }

  const vite = await loadVite(root, /** @type {string} */ (apps[0]), failures);
  if (vite === null) return { graph, seconds: 0, failures };

  const started = Date.now();
  // Every declared app must record, not one of them: `graph.completed` is a floor, and
  // a floor that is satisfied by the app that happened to work is not a floor.
  let allCompleted = true;

  for (const app of apps) {
    let completed = false;

    const recorder = {
      name: "alfred-web-bundle-graph-recorder",
      // Snapshot in `buildEnd` rather than in `moduleParsed`: at parse time a
      // module's `importers` is whatever has been seen so far, and the chain a
      // violation reports has to be the finished one.
      /**
       * @this {{ getModuleIds: () => Iterable<string>, getModuleInfo: (id: string) => { importers: readonly string[], isEntry: boolean } | null }}
       */
      buildEnd(error) {
        if (error) return;
        for (const id of this.getModuleIds()) {
          const info = this.getModuleInfo(id);
          if (info === null) continue;
          graph.importers.set(id, [...info.importers]);
          if (info.isEntry) graph.entries.push(id);
        }
        completed = true;
      },
    };

    try {
      await vite.build({
        root: join(root, app),
        configFile: join(root, app, VITE_CONFIG),
        plugins: [recorder],
        build: {
          write: false,
          minify: false,
          reportCompressedSize: false,
          rollupOptions: {
            // The second argument is not optional, and forgetting it is the sharpest
            // trap in this file. Supplying `onwarn` REPLACES vite's own `viteLog`
            // handler, and `viteLog` is where vite turns `UNRESOLVED_IMPORT` into a
            // thrown error. `normalizeUserOnWarn` hands the default in only as an
            // opt-in second argument, so the obvious collector — `onwarn(w) {
            // record(w); }` — silently disarms a build failure this repo already
            // relies on: an unresolved import stops aborting the build and becomes a
            // recorded warning nobody exits on. Record, then delegate.
            onwarn(warning, defaultHandler) {
              graph.warnings.push(
                typeof warning === "string" ? warning : String(warning?.message ?? warning),
              );
              defaultHandler(warning);
            },
          },
        },
      });
    } catch (error) {
      failures.push(
        `the vite build of ${app} failed (${error instanceof Error ? error.message : String(error)}), so its module graph is incomplete. Fix the build first: a failed build is not a clean bundle.`,
      );
    }

    if (!completed) {
      failures.push(
        `the recorder's buildEnd hook never ran for ${app}, so nothing was recorded for it.`,
      );
    }
    allCompleted = allCompleted && completed;
  }

  graph.completed = allCompleted;
  return { graph, seconds: (Date.now() - started) / 1000, failures };
}
