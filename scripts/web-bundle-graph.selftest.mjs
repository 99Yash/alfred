// Fixtures for the browser bundle-graph rules.
//
// Every rule in `web-bundle-graph.mjs` is an emptiness assertion, so a clean run of a
// rule that cannot see its own violation is indistinguishable from a clean run of a
// rule that works — and the real graph is clean today, which means a green run over the
// real tree is not evidence of anything. So every case here asserts the MUTATION fails:
// each one names the exact expected result rather than "non-empty", so a rule that
// starts answering something else cannot pass as this one.
//
// `scripts/` has no CI test job and no tsconfig runs a suite, so this file is run by
// `check-web-bundle-graph.mjs` itself, before the 7-9 s vite build. A test file that
// only a job which does not exist would run is a dead guard.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { FORBIDDEN_RUNTIME_PACKAGES } from "./web-boundaries.mjs";
import {
  BROWSER_SAFE_NPM_PACKAGES,
  bundleViolations,
  classifyModuleId,
  importerChain,
  nodeOnlyPackages,
} from "./web-bundle-graph.mjs";

/** The NUL that prefixes a rollup virtual module id. */
const NUL = "\u0000";

/** vite's externalization sentence, copied verbatim from a vite 6.4.3 build. */
const EXTERNALIZED = (builtin, importer) =>
  `Module "${builtin}" has been externalized for browser compatibility, imported by "${importer}".`;

function write(root, relative, content) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function withFixture(body) {
  const fixture = mkdtempSync(join(tmpdir(), "web-bundle-graph-"));
  try {
    return body(fixture);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

/**
 * A recorded graph, in the shape `recordBundleGraph` hands back.
 *
 * @param {string} root
 * @param {[string, string[]][]} importers
 * @param {{ entries?: string[], warnings?: string[], completed?: boolean }} [recorded]
 */
function graphOf(root, importers, recorded = {}) {
  const { entries = [], warnings = [], completed = true } = recorded;
  return { root, importers: new Map(importers), entries, warnings, completed };
}

function expect(actual, expected, label, failures) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) failures.push(`${label}: expected ${right}, received ${left}`);
}

/**
 * The four measured id-normalisation traps, plus the kinds that partition the rest.
 *
 * Two cases cover the NUL, and the SECOND one is the discriminating one. The measured
 * leading-NUL form — `\0/Users/…/jsx-runtime.js?commonjs-es-import`, which reads as an
 * absolute path — turns out to be caught with or without a NUL test at all: on posix a
 * string starting with `\0` does not start with `/`, so `path.isAbsolute` answers
 * `false` for it. Driving the mutation is what showed that. A suite that stopped at
 * that case would have reported the NUL rule proven while every mutation of it stayed
 * green, which is this campaign's recurring fails-open shape.
 *
 * The form that discriminates is a NUL that is NOT leading. Without the test, or with
 * it narrowed to `startsWith`, that id classifies as a workspace file whose name
 * carries a NUL and a rollup suffix, and R3 reports a file that does not exist as a
 * hole in the source fence.
 */
function classifyFailures() {
  const failures = [];

  withFixture((root) => {
    write(root, "packages/contracts/src/index.ts", "export const a = 1;\n");
    write(root, "apps/web/src/routes/support.tsx", "export const Route = 1;\n");
    write(root, "apps/web/index.html", "<html></html>\n");
    mkdirSync(join(root, "node_modules/@alfred"), { recursive: true });
    // pnpm links a workspace package into `node_modules` as a symlink, so the id form
    // this covers is the one a `resolve.preserveSymlinks` flip would produce.
    symlinkSync(join(root, "packages/contracts"), join(root, "node_modules/@alfred/contracts"));

    const abs = (relative) => join(root, relative);
    const cases = [
      [
        `${NUL}${abs("node_modules/react/jsx-runtime.js")}?commonjs-es-import`,
        { kind: "virtual", package: null, file: null },
        "a NUL-prefixed id whose remainder looks absolute is virtual, not workspace",
      ],
      [
        `${abs("apps/web/src/main.tsx")}${NUL}commonjs-proxy`,
        { kind: "virtual", package: null, file: null },
        "an id whose NUL is not leading is still virtual, which is what makes the includes test load-bearing",
      ],
      [
        `${abs("apps/web/src/routes/support.tsx")}?tsr-split=component`,
        { kind: "workspace", package: null, file: "apps/web/src/routes/support.tsx" },
        "a ?tsr-split= route id strips to the bare .tsx path",
      ],
      [
        abs("apps/web/src/routes/support.tsx"),
        { kind: "workspace", package: null, file: "apps/web/src/routes/support.tsx" },
        "the bare form of a split route classifies identically, so the pair cannot double-count",
      ],
      [
        `${abs("node_modules/pg/lib/index.js")}?commonjs-module`,
        { kind: "npm", package: "pg", file: null },
        "a ?commonjs- suffix strips off an npm id",
      ],
      [
        abs("node_modules/@alfred/contracts/src/index.ts"),
        { kind: "workspace", package: null, file: "packages/contracts/src/index.ts" },
        "a symlinked workspace id resolves through the realpath fallback to its source path",
      ],
      [
        "__vite-browser-external",
        { kind: "builtin-stub", package: null, file: null },
        "the externalized-builtin stub id",
      ],
      [
        abs("node_modules/@aws-sdk/client-s3/dist/index.js"),
        { kind: "npm", package: "@aws-sdk/client-s3", file: null },
        "a scoped npm package keeps both segments",
      ],
      [
        abs("node_modules/a/node_modules/b/index.js"),
        { kind: "npm", package: "b", file: null },
        "the LAST node_modules segment names the package",
      ],
      [
        abs("node_modules/.pnpm/react@19.0.0/node_modules/react/index.js"),
        { kind: "npm", package: "react", file: null },
        "a pnpm store path names the package, not the store layout",
      ],
      [
        "vite/preload-helper",
        { kind: "virtual", package: null, file: null },
        "a bare specifier that never resolved to a path is virtual",
      ],
      [
        abs("apps/web/index.html"),
        { kind: "workspace", package: null, file: "apps/web/index.html" },
        "the bundler entry document is a workspace member, and R3 filters it by extension",
      ],
      [
        "/definitely-not-a-path-in-this-repo/module.js",
        { kind: "foreign", package: null, file: null },
        "an absolute path outside the repo and outside node_modules is foreign, not silently dropped",
      ],
    ];

    for (const [id, expected, label] of cases) {
      expect(classifyModuleId(root, id), expected, `classifyModuleId — ${label}`, failures);
    }
  });

  return failures;
}

/**
 * A repository shaped like this one, so `listWorkspaces` and `browserSurface` resolve.
 *
 * Nothing is committed: discovery asks git for `--others --exclude-standard`.
 */
function initWorkspaceRepo(fixture, { nodeDependencies }) {
  execFileSync("git", ["init", "--quiet"], { cwd: fixture });
  write(fixture, "pnpm-workspace.yaml", "packages:\n  - apps/*\n  - packages/*\n");

  // The browser side. `apps/web` declares `@alfred/api` for a type-only import, which
  // is the exact shape that makes a subtraction-only forbid set wrong.
  write(
    fixture,
    "apps/web/package.json",
    JSON.stringify({ name: "web", dependencies: { "@alfred/api": "workspace:*" } }),
  );
  write(
    fixture,
    "apps/web/src/main.tsx",
    'import type { App } from "@alfred/api";\nimport { a } from "@alfred/contracts";\n',
  );
  write(fixture, "packages/contracts/package.json", JSON.stringify({ name: "@alfred/contracts" }));
  write(fixture, "packages/contracts/src/index.ts", "export const a = 1;\n");

  // The Node side.
  write(
    fixture,
    "packages/db/package.json",
    JSON.stringify({ name: "@alfred/db", dependencies: nodeDependencies }),
  );
  write(fixture, "packages/db/src/index.ts", "export const b = 1;\n");
}

/** Every declared exception, so the stale-exception rule is quiet unless it is tested. */
function everyException() {
  const dependencies = {};
  for (const pkg of BROWSER_SAFE_NPM_PACKAGES.keys()) dependencies[pkg] = "1.0.0";
  return dependencies;
}

/**
 * The forbid set, derived. Three assertions, and the second one is the whole design:
 * `apps/web` declares `@alfred/api` and no Node-only workspace does, so a rule that
 * subtracted the browser side's dependencies would drop the most forbidden package in
 * the repo out of its own forbid set.
 */
function forbidSetFailures() {
  const failures = [];

  withFixture((root) => {
    initWorkspaceRepo(root, { nodeDependencies: { pg: "8.0.0", ...everyException() } });
    const { packages, failures: reported } = nodeOnlyPackages(root);

    expect(reported, [], "nodeOnlyPackages — a well-formed fixture reports no failure", failures);
    expect(
      packages.has("pg"),
      true,
      "nodeOnlyPackages — a Node-only workspace's dependency is forbidden",
      failures,
    );
    for (const pkg of BROWSER_SAFE_NPM_PACKAGES.keys()) {
      expect(
        packages.has(pkg),
        false,
        `nodeOnlyPackages — the declared exception ${pkg} is not forbidden even though the Node side declares it`,
        failures,
      );
    }
    expect(
      packages.has("@alfred/api"),
      true,
      "nodeOnlyPackages — @alfred/api stays forbidden although only the browser app declares it",
      failures,
    );
    expect(
      packages.get("@alfred/api")?.includes("FORBIDDEN_RUNTIME_PACKAGES"),
      true,
      "nodeOnlyPackages — @alfred/api is forbidden BY the union term, not by accident",
      failures,
    );
    for (const pkg of FORBIDDEN_RUNTIME_PACKAGES) {
      expect(
        packages.has(pkg),
        true,
        `nodeOnlyPackages — the source fence's forbidden package ${pkg} is in the set`,
        failures,
      );
    }
    expect(
      packages.has("@alfred/contracts"),
      false,
      "nodeOnlyPackages — a browser-reached workspace is not forbidden",
      failures,
    );
  });

  // A declared exception that nothing declares excuses nothing, and says so.
  withFixture((root) => {
    const dependencies = everyException();
    delete dependencies["react-dom"];
    initWorkspaceRepo(root, { nodeDependencies: dependencies });
    const { failures: reported } = nodeOnlyPackages(root);
    expect(
      reported.filter((failure) => failure.includes("react-dom")).length,
      1,
      "nodeOnlyPackages — a BROWSER_SAFE_NPM_PACKAGES entry no Node workspace declares is reported",
      failures,
    );
  });

  // An unreadable manifest is a reported failure, never a silently smaller forbid set.
  withFixture((root) => {
    initWorkspaceRepo(root, { nodeDependencies: everyException() });
    write(root, "packages/broken/package.json", "{ not json");
    write(root, "packages/broken/src/index.ts", "export const c = 1;\n");
    const { failures: reported } = nodeOnlyPackages(root);
    expect(
      reported.some((failure) => failure.includes("packages/broken/package.json")),
      true,
      "nodeOnlyPackages — an unparseable manifest is reported rather than skipped",
      failures,
    );
  });

  return failures;
}

/** The rules and the floors, over synthetic graphs. */
function violationFailures() {
  const failures = [];

  const rulesOf = (violations) => violations.map((violation) => violation.rule).sort();
  const subjectsOf = (violations) => violations.map((violation) => violation.subject);

  withFixture((root) => {
    write(root, "apps/web/src/main.tsx", "export const main = 1;\n");
    write(root, "apps/web/src/lib/eden.ts", "export const eden = 1;\n");
    write(root, "apps/web/src/routes/-preview/panel.tsx", "export const Panel = 1;\n");
    write(root, "apps/web/index.html", "<html></html>\n");

    const abs = (relative) => join(root, relative);
    const entry = abs("apps/web/src/main.tsx");
    const eden = abs("apps/web/src/lib/eden.ts");
    const forbidden = new Map([["pg", "packages/db declares it as a dependency"]]);
    const surface = new Set(["apps/web/src/main.tsx", "apps/web/src/lib/eden.ts"]);

    // A forbidden npm package four hops from the entry: one violation, and the chain
    // back to the browser file is the part that makes it a diagnosis.
    const deep = abs("node_modules/@alfred/db/src/index.ts");
    const pg = abs("node_modules/pg/lib/index.js");
    const leak = graphOf(
      root,
      [
        [entry, []],
        [eden, [entry]],
        [deep, [eden]],
        [pg, [deep]],
      ],
      { entries: [entry] },
    );
    const leaked = bundleViolations(leak, { forbidden, surface });
    expect(rulesOf(leaked), ["forbidden-package"], "bundleViolations — a pg module", failures);
    expect(subjectsOf(leaked), ["pg"], "bundleViolations — names the package", failures);
    expect(
      leaked[0]?.chain,
      [
        "apps/web/src/main.tsx",
        "apps/web/src/lib/eden.ts",
        "@alfred/db (npm)",
        "pg (npm)",
      ],
      "bundleViolations — carries the importer chain from the browser entry",
      failures,
    );

    // The builtin stub: the verdict is the id, the naming comes from the warning.
    const builtin = graphOf(
      root,
      [
        [entry, []],
        ["__vite-browser-external", [entry]],
      ],
      { entries: [entry], warnings: [EXTERNALIZED("node:fs", entry)] },
    );
    const externalized = bundleViolations(builtin, { forbidden, surface });
    expect(rulesOf(externalized), ["node-builtin"], "bundleViolations — the stub id", failures);
    expect(
      externalized[0]?.message.includes("node:fs"),
      true,
      "bundleViolations — the recorded vite 6.4.3 sentence names the builtin in the message",
      failures,
    );
    expect(
      externalized[0]?.chain,
      ["apps/web/src/main.tsx", "__vite-browser-external"],
      "bundleViolations — the stub's importers name the browser file that leaked",
      failures,
    );

    // The verdict does not depend on the sentence: a reworded warning still fails.
    const reworded = graphOf(
      root,
      [
        [entry, []],
        ["__vite-browser-external", [entry]],
      ],
      { entries: [entry], warnings: ["some future vite rewords this entirely"] },
    );
    expect(
      rulesOf(bundleViolations(reworded, { forbidden, surface })),
      ["node-builtin"],
      "bundleViolations — a vite reword leaves the verdict armed, only less specific",
      failures,
    );

    // R3: a workspace module the bundle reaches and the fence does not scan.
    const preview = abs("apps/web/src/routes/-preview/panel.tsx");
    const hole = graphOf(
      root,
      [
        [entry, []],
        [preview, [entry]],
      ],
      { entries: [entry] },
    );
    const holes = bundleViolations(hole, { forbidden, surface });
    expect(rulesOf(holes), ["unscanned-module"], "bundleViolations — an unscanned module", failures);
    expect(
      subjectsOf(holes),
      ["apps/web/src/routes/-preview/panel.tsx"],
      "bundleViolations — names the unscanned file",
      failures,
    );

    // R3 rules on the two extensions the source fence scans, so the entry document a
    // real build always contains is not reported as a hole in it.
    const document = graphOf(
      root,
      [
        [entry, []],
        [abs("apps/web/index.html"), [entry]],
      ],
      { entries: [entry] },
    );
    expect(
      rulesOf(bundleViolations(document, { forbidden, surface })),
      [],
      "bundleViolations — a non-TypeScript workspace member is outside R3",
      failures,
    );

    // A module no rule can classify is reported rather than dropped.
    const stranger = graphOf(
      root,
      [
        [entry, []],
        ["/definitely-not-a-path-in-this-repo/module.js", [entry]],
      ],
      { entries: [entry] },
    );
    expect(
      rulesOf(bundleViolations(stranger, { forbidden, surface })),
      ["unclassified-module"],
      "bundleViolations — a foreign absolute path",
      failures,
    );

    // The floors. This is the mutation that matters most: without them every rule
    // above passes over a graph that recorded nothing.
    const empty = graphOf(root, [], { completed: false });
    const floors = bundleViolations(empty, { forbidden, surface });
    expect(
      rulesOf(floors),
      ["vacuous-graph", "vacuous-graph", "vacuous-graph"],
      "bundleViolations — an empty graph fires all three non-vacuity floors",
      failures,
    );
    expect(
      subjectsOf(floors),
      ["buildEnd", "src/main.tsx", "workspace modules"],
      "bundleViolations — each floor names what was missing",
      failures,
    );

    // A finished build whose graph holds only third-party modules still has no anchor.
    const anchorless = graphOf(root, [[pg, []]], { entries: [pg] });
    expect(
      subjectsOf(bundleViolations(anchorless, { forbidden, surface })).sort(),
      ["pg", "src/main.tsx", "workspace modules"],
      "bundleViolations — a graph with no workspace module fails its floors as well as its rules",
      failures,
    );

    // A clean graph is clean. Without this, a rule that fires on everything would pass
    // every case above.
    const clean = graphOf(
      root,
      [
        [entry, []],
        [eden, [entry]],
      ],
      { entries: [entry] },
    );
    expect(
      bundleViolations(clean, { forbidden, surface }),
      [],
      "bundleViolations — a graph inside the surface with no forbidden package is clean",
      failures,
    );
  });

  return failures;
}

/** The chain, including the two shapes that make a naive walk wrong. */
function chainFailures() {
  const failures = [];
  const root = "/repo";

  const four = graphOf(root, [
    ["entry", []],
    ["a", ["entry"]],
    ["b", ["a"]],
    ["leaf", ["b"]],
  ], { entries: ["entry"] });
  expect(
    importerChain(four, "leaf"),
    ["entry", "a", "b", "leaf"],
    "importerChain — a four-hop chain returns four hops",
    failures,
  );

  const cyclic = graphOf(root, [
    ["a", ["b"]],
    ["b", ["a"]],
  ]);
  const chain = importerChain(cyclic, "a");
  expect(
    chain.length <= 2 && chain[chain.length - 1] === "a",
    true,
    "importerChain — a cycle terminates and still ends at the subject",
    failures,
  );

  expect(
    importerChain(four, "absent"),
    [],
    "importerChain — an id the graph does not hold has no chain",
    failures,
  );

  return failures;
}

/** Every fixture failure, for `check-web-bundle-graph.mjs` to exit on. */
export function webBundleGraphSelfTestFailures() {
  return [
    ...classifyFailures(),
    ...forbidSetFailures(),
    ...violationFailures(),
    ...chainFailures(),
  ];
}
