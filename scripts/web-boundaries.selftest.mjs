// Fixtures for the browser-boundary rules. A clean run of a fence that cannot see
// its own violation is indistinguishable from a clean run of a fence that works,
// so every case here asserts the MUTATION fails, not merely that the happy path
// passes.
//
// `scripts/` has no CI test job and `check-types` skips the tree, so this suite is
// run by `check-web-boundaries.mjs` itself — the same wiring
// `check-consolidation-drift.mjs` uses for its rule table. A test file that only a
// job which does not exist would run is a dead guard.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FORBIDDEN_RUNTIME_PACKAGES,
  browserRoots,
  browserSurface,
  docListFailures,
  findViolations,
  hasRuntimeBinding,
} from "./web-boundaries.mjs";

function write(root, relative, content) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function workspace(root, name, files) {
  write(root, `packages/${name}/package.json`, `{ "name": "@alfred/${name}" }\n`);
  for (const [relative, content] of Object.entries(files)) {
    write(root, `packages/${name}/src/${relative}`, content);
  }
}

function withFixture(prefix, body) {
  const fixture = mkdtempSync(join(tmpdir(), prefix));
  try {
    return body(fixture);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

/**
 * A repository shaped like this one: workspace roots declared in the yaml, and
 * `apps/web` declared as a workspace so the enumeration lists the app the fence
 * seeds from.
 *
 * Nothing is committed — discovery asks git for `--others --exclude-standard`.
 * Without the `apps/web` manifest the fence still seeds `apps/web/src`, but it also
 * reports that `BROWSER_ENTRY_APPS` names an app the enumeration does not list. That
 * is the ruling working, and noise in every fixture that is about something else, so
 * the fixtures that mean to test it declare it explicitly instead.
 */
function initWorkspaceRepo(fixture) {
  execFileSync("git", ["init", "--quiet"], { cwd: fixture });
  write(fixture, "pnpm-workspace.yaml", "packages:\n  - apps/*\n  - packages/*\n");
  write(fixture, "apps/web/package.json", '{ "name": "web" }\n');
}

function runtimeBindingFailures() {
  const failures = [];
  // One rule over every clause shape: a clause is erased only when the `type`
  // keyword LEADS it. Everything else is a module load.
  //
  // The three cells that look surprising are the point. `{ type A }`, `{ type A,
  // type B }` and `{}` bind no value, but under `verbatimModuleSyntax`
  // (`packages/config/tsconfig.base.json:8`, which `apps/web/tsconfig.json`
  // extends) TypeScript emits `import {} from "@alfred/db"` for all three — a
  // live evaluation that drags the package's Node-only dependencies into the
  // bundle. A predicate that called them erased both under-reported a real leak
  // and dropped the package out of browser-root discovery entirely.
  //
  // The clause the walk hands over is the source between the `import`/`export`
  // keyword and the `from` token, so ` { type A } ` and never ` { type A } from `.
  // Widening the slice over the `from` token would flip `{ type A }` to `true`
  // for the wrong reason and make these cells pass vacuously — which is why the
  // two fixtures below assert the same rule at the file level as well.
  const cases = [
    ["type A", false],
    ["type { A }", false],
    ["{ type A }", true],
    ["{ type A, type B }", true],
    ["{ type A as B }", true],
    ["{}", true],
    ["{ type A, b }", true],
    ["{ A }", true],
    ["A", true],
    ["* as A", true],
    // A side-effect, dynamic or `require` form carries no clause at all.
    ["", true],
  ];
  for (const [clause, expected] of cases) {
    if (hasRuntimeBinding(clause) !== expected) {
      failures.push(`hasRuntimeBinding("${clause}") must be ${expected}, received ${!expected}`);
    }
  }
  return failures;
}

/**
 * The reporting half, at file level: an all-`type` brace clause on a forbidden
 * package is a violation.
 *
 * Asserts the exact violation list rather than "non-empty", so a fixture that
 * starts reporting something else cannot pass as this one.
 */
function inlineTypeClauseViolationFailures() {
  return withFixture("alfred-web-boundaries-inline-type-", (fixture) => {
    const failures = [];
    initWorkspaceRepo(fixture);

    write(
      fixture,
      "apps/web/src/entry.ts",
      ['import { type Database } from "@alfred/db";', "export type Handle = Database;"].join("\n"),
    );
    workspace(fixture, "db", { "d.ts": "export type Database = { id: string };\n" });

    const violations = findViolations(fixture, "apps/web/src/entry.ts");
    const expected = [{ line: 1, specifier: "@alfred/db" }];
    if (JSON.stringify(violations) !== JSON.stringify(expected)) {
      failures.push(
        `an all-type brace clause on a forbidden package is a module load under verbatimModuleSyntax and must be reported: expected ${JSON.stringify(expected)}, received ${JSON.stringify(violations)}`,
      );
    }
    return failures;
  });
}

/**
 * The root-discovery half, which is the half with the wider blast radius: the
 * surface follows an all-`type` brace clause, so the package it reaches is
 * scanned.
 *
 * Calling that clause erased does not merely under-report the clause itself — it
 * keeps the whole package out of the fence, so a genuine leak anywhere in its
 * `src/` goes unreported. The inline-`type` import is deliberately the ONLY edge
 * into `typedonly`: give it a second, runtime edge and the case passes whatever
 * the predicate answers, and proves nothing.
 */
function inlineTypeClauseRootFailures() {
  return withFixture("alfred-web-boundaries-inline-type-root-", (fixture) => {
    const failures = [];
    buildReachabilityFixture(fixture);

    write(
      fixture,
      "apps/web/src/typed.ts",
      ['import { type Widget } from "@alfred/typedonly";', "export type Handle = Widget;"].join(
        "\n",
      ),
    );
    workspace(fixture, "typedonly", {
      "w.ts": "export type Widget = { id: string };\n",
      // The genuine leak that a missing root hides.
      "leak.ts": 'import { serverEnv } from "@alfred/env/server";\nexport const leak = serverEnv;\n',
    });

    const roots = browserRoots(fixture);
    if (!roots.includes("packages/typedonly/src")) {
      failures.push(
        `a package reached ONLY through an all-type brace clause must still become a browser root: expected packages/typedonly/src in ${JSON.stringify(roots)}`,
      );
    }

    const flagged = browserSurface(fixture)
      .files.filter((file) => findViolations(fixture, file).length > 0)
      .sort();
    if (!flagged.includes("packages/typedonly/src/leak.ts")) {
      failures.push(
        `the leak inside a package reached only through an all-type brace clause must be reported: expected packages/typedonly/src/leak.ts in ${JSON.stringify(flagged)}`,
      );
    }
    return failures;
  });
}

/**
 * A specifier is only an import when a statement puts it there.
 *
 * Every case below is text a reader would call prose: an `@alfred/*` specifier
 * quoted in a comment or inside a template literal. A scan that reads lines
 * instead of statements reports each of them, and the consequence is not a
 * stray warning — a mentioned package is promoted to a browser root, so its own
 * legitimate server-side imports become failures and a documentation edit turns
 * the gate red.
 *
 * Each fixture is a pair. The quiet half is the mention that must stay silent;
 * the loud half is a real statement in the same file that must still be
 * reported, so a scanner that has gone blind altogether fails here too.
 */
function lexicalPositionFailures() {
  return withFixture("alfred-web-boundaries-lexical-", (fixture) => {
    const failures = [];
    // The block comment and the template literal both hold a line that starts
    // at column 0 with the word `import`. Anchoring a regex to the start of a
    // line answers those two wrong; only a walk that knows where the comment
    // and the literal begin can skip them.
    const source = [
      "/**",
      ' * Superseded: this module used to `import { pool } from "@alfred/db";`.',
      " */",
      '// import { serverEnv } from "@alfred/env/server";',
      "/*",
      'import { auth } from "@alfred/auth";',
      "*/",
      "const snippet = `",
      'import { treaty } from "@alfred/api";',
      "`;",
      'import { pool } from "@alfred/db";',
      "export const used = [snippet, pool];",
      "",
    ].join("\n");
    write(fixture, "sample.ts", source);

    const violations = findViolations(fixture, "sample.ts");
    const expected = [{ line: 11, specifier: "@alfred/db" }];
    if (JSON.stringify(violations) !== JSON.stringify(expected)) {
      failures.push(
        `findViolations must report the one real import and none of the four mentions: expected ${JSON.stringify(expected)}, received ${JSON.stringify(violations)}`,
      );
    }
    return failures;
  });
}

/**
 * The same rule at the surface level, where it costs the most.
 *
 * `browserRoots` follows runtime bindings, so a mention decides whether a whole
 * package tree is fenced. Reading a comment as an import adds a server-side
 * package to the browser surface and reddens the gate on code that never
 * reaches the browser; failing to read a real import next to a comment drops a
 * package tree out of the surface with no output at all. The second direction
 * is the dangerous one, because nothing about it looks like a failure.
 */
function mentionedPackageRootFailures() {
  const failures = [];

  const build = (fixture, edge) => {
    initWorkspaceRepo(fixture);
    write(fixture, "apps/web/src/entry.ts", `${edge}\nexport const used = 1;\n`);
    workspace(fixture, "logging", { "log.ts": "export const log = 1;\n" });
  };

  withFixture("alfred-web-boundaries-mention-", (fixture) => {
    build(fixture, '// import { log } from "@alfred/logging";');
    const roots = browserRoots(fixture);
    if (roots.includes("packages/logging/src")) {
      failures.push(
        `a commented-out import must not promote its package to a browser root, received ${JSON.stringify(roots)}`,
      );
    }
  });

  withFixture("alfred-web-boundaries-mention-armed-", (fixture) => {
    build(fixture, 'import { log } from "@alfred/logging";');
    const roots = browserRoots(fixture);
    if (!roots.includes("packages/logging/src")) {
      failures.push(
        `the same import, uncommented, must promote its package to a browser root, received ${JSON.stringify(roots)}`,
      );
    }
  });

  // The loss direction: a comment above the file's only edge to a package. A
  // scan that lets a comment swallow the statement below it reads this file as
  // having no runtime binding, and the package leaves the fence entirely — no
  // root, so no violation and no emptiness to report.
  withFixture("alfred-web-boundaries-swallow-root-", (fixture) => {
    initWorkspaceRepo(fixture);
    write(
      fixture,
      "apps/web/src/entry.ts",
      [
        "// Prefer import type wherever the symbol erases at build time.",
        'import { log } from "@alfred/logging";',
        "export const used = log;",
        "",
      ].join("\n"),
    );
    workspace(fixture, "logging", { "log.ts": "export const log = 1;\n" });

    const roots = browserRoots(fixture);
    if (!roots.includes("packages/logging/src")) {
      failures.push(
        `a comment above the only edge to a package must not remove that package from the surface, received ${JSON.stringify(roots)}`,
      );
    }
  });

  return failures;
}

/**
 * One statement's clause must not run into the next statement's.
 *
 * A scan built from one lazy match reads everything between the first `import`
 * keyword it finds and the first specifier it can reach as a single clause. The
 * verdict it computes from that concatenation is right only by accident, and
 * both shapes below are the accident going the other way: the joined text opens
 * with `type `, so a real runtime import reads as type-only and is not
 * reported.
 */
function statementBoundaryFailures() {
  const failures = [];

  const expectViolation = (label, source, expected) =>
    withFixture("alfred-web-boundaries-statement-", (fixture) => {
      write(fixture, "sample.ts", source);
      const violations = findViolations(fixture, "sample.ts");
      if (JSON.stringify(violations) !== JSON.stringify(expected)) {
        failures.push(
          `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(violations)}`,
        );
      }
    });

  // A prose header that happens to use the words `import type`. This is the
  // shape that is live in nineteen files of the real browser surface today.
  expectViolation(
    "a comment above an import must not lend that import its own clause",
    [
      "/**",
      " * Prefer import type wherever the symbol erases at build time.",
      " */",
      'import { pool } from "@alfred/db";',
      "export const used = pool;",
      "",
    ].join("\n"),
    [{ line: 4, specifier: "@alfred/db" }],
  );

  // A preceding statement rather than a comment. A clause that may span a `;`
  // reads the type alias and the re-export as one import.
  expectViolation(
    "a preceding statement must not lend a re-export its own clause",
    ["export type Props = { a: string };", 'export { thing } from "@alfred/db";', ""].join("\n"),
    [{ line: 2, specifier: "@alfred/db" }],
  );

  // The known blind spot, pinned so a later widening is a deliberate edit
  // rather than a surprise: the walk needs a string in the argument position,
  // so a computed dynamic import is invisible to the fence.
  expectViolation(
    "a computed dynamic import stays invisible",
    ['const name = "@alfred/db";', "export const load = () => import(name);", ""].join("\n"),
    [],
  );

  return failures;
}

/**
 * A fixture repo: a web app, a reachable chain, a cycle, one package reached
 * through each of the three import shapes, and two decoys.
 */
function buildReachabilityFixture(fixture) {
  initWorkspaceRepo(fixture);

  write(
    fixture,
    "apps/web/src/entry.ts",
    [
      'import { thing } from "@alfred/fake";',
      'import type { Shape } from "@alfred/typeonly";',
      'import { pool } from "@alfred/db";',
      "export const used = [thing, pool] satisfies Shape[];",
    ].join("\n"),
  );

  // `.tsx` is 61% of the real `apps/web/src`, and it reaches `@alfred/component`
  // and its leak through no other file — so a scan surface that drops the
  // extension fails both the roots case and the violation case below, rather
  // than unfencing every React component in silence.
  write(
    fixture,
    "apps/web/src/widget.tsx",
    ['import { rendered } from "@alfred/component";', "export const Widget = () => rendered;"].join(
      "\n",
    ),
  );

  // The scan has three detection patterns and the two files above exercise only
  // the static one. Both idioms below are live in the real `apps/web/src` (lazy
  // routes and deferred Sentry use `import(...)`; two files import for side
  // effects), and each reaches its package through no other file, so deleting
  // either pattern drops a root here and a violation in the scan case below.
  write(
    fixture,
    "apps/web/src/boot.ts",
    ['import "@alfred/sideeffect";', 'export const lazy = () => import("@alfred/dynamic");'].join(
      "\n",
    ),
  );

  workspace(fixture, "fake", { "b.ts": 'export { deep as thing } from "@alfred/deeper";\n' });
  // Closes a cycle back to `fake`; the walk must terminate.
  workspace(fixture, "deeper", { "c.ts": 'import "@alfred/fake";\nexport const deep = 1;\n' });
  workspace(fixture, "component", { "w.tsx": "export const rendered = 1;\n" });
  workspace(fixture, "sideeffect", { "s.ts": "export const registered = 1;\n" });
  workspace(fixture, "dynamic", { "y.ts": "export const later = 1;\n" });
  workspace(fixture, "typeonly", { "t.ts": "export type Shape = { id: string };\n" });
  workspace(fixture, "db", { "d.ts": "export const pool = 1;\n" });
  workspace(fixture, "unreached", { "u.ts": "export const nobody = 1;\n" });
}

function browserRootsFailures() {
  return withFixture("alfred-web-boundaries-roots-", (fixture) => {
    const failures = [];
    buildReachabilityFixture(fixture);

    const roots = browserRoots(fixture);
    const expected = [
      "apps/web/src",
      "packages/component/src",
      "packages/deeper/src",
      "packages/dynamic/src",
      "packages/fake/src",
      "packages/sideeffect/src",
    ];
    if (JSON.stringify(roots) !== JSON.stringify(expected)) {
      failures.push(
        `browserRoots must follow runtime @alfred/* bindings transitively through static, side-effect and dynamic imports, skip forbidden and type-only packages, and terminate on a cycle: expected ${JSON.stringify(expected)}, received ${JSON.stringify(roots)}`,
      );
    }
    return failures;
  });
}

function widenedScanFailures() {
  return withFixture("alfred-web-boundaries-scan-", (fixture) => {
    const failures = [];
    buildReachabilityFixture(fixture);

    // The assertion that fails against a scan surface fixed at `apps/web/src`.
    write(
      fixture,
      "packages/fake/src/leak.ts",
      'import { serverEnv } from "@alfred/env/server";\nexport const leak = serverEnv;\n',
    );
    // The same leak in a `.tsx`, reachable only through the fixture's own `.tsx`
    // entry: it disappears from this list if either extension leaves the surface.
    write(
      fixture,
      "packages/component/src/leak.tsx",
      'import { serverEnv } from "@alfred/env/server";\nexport const leak = serverEnv;\n',
    );
    // Same leak, in a package nothing reaches: the fence follows the bundle, so
    // this one must stay unreported.
    write(
      fixture,
      "packages/unreached/src/leak.ts",
      'import { serverEnv } from "@alfred/env/server";\nexport const leak = serverEnv;\n',
    );
    // A forbidden package taken through a side-effect import and through a
    // dynamic one. Neither clause binds a name, so both are runtime bindings by
    // construction — and each of these files is doubly load-bearing: dropping
    // the pattern stops the package being reached AND stops the leak inside it
    // being recognised.
    write(fixture, "packages/sideeffect/src/leak.ts", 'import "@alfred/db";\n');
    write(
      fixture,
      "packages/dynamic/src/leak.ts",
      'export const load = () => import("@alfred/env/server");\n',
    );

    const flagged = browserSurface(fixture)
      .files.filter((file) => findViolations(fixture, file).length > 0)
      .sort();
    // `entry.ts` is the old surface's own catch (it binds `@alfred/db`); the
    // other four are the ones a scan fixed at `apps/web/src` cannot see.
    const expected = [
      "apps/web/src/entry.ts",
      "packages/component/src/leak.tsx",
      "packages/dynamic/src/leak.ts",
      "packages/fake/src/leak.ts",
      "packages/sideeffect/src/leak.ts",
    ];
    if (JSON.stringify(flagged) !== JSON.stringify(expected)) {
      failures.push(
        `the scan must cover every browser-reachable package and nothing else: expected ${JSON.stringify(expected)}, received ${JSON.stringify(flagged)}`,
      );
    }
    return failures;
  });
}

/** The three shapes that make the fence resolve nothing while looking clean. */
function surfaceFailureFailures() {
  const failures = [];

  // A root that exists and is listed, and whose files the scan cannot read: one
  // package written in plain `.js`, one whose sources moved to `lib/` and left an
  // empty `src/` behind (git tracks no empty directory, so a stray file is what
  // survives such a move). Both pass the `existsSync` guard, so both would sit
  // inside the surface holding a leak nobody reads.
  withFixture("alfred-web-boundaries-empty-root-", (fixture) => {
    initWorkspaceRepo(fixture);
    write(
      fixture,
      "apps/web/src/entry.ts",
      [
        'import { plain } from "@alfred/jsonly";',
        'import { moved } from "@alfred/relocated";',
        "export const used = [plain, moved];",
      ].join("\n"),
    );
    workspace(fixture, "jsonly", {
      "index.js":
        'import { serverEnv } from "@alfred/env/server";\nexport const plain = serverEnv;\n',
    });
    write(fixture, "packages/relocated/package.json", '{ "name": "@alfred/relocated" }\n');
    write(fixture, "packages/relocated/src/.keep", "");
    write(
      fixture,
      "packages/relocated/lib/index.ts",
      'import { serverEnv } from "@alfred/env/server";\nexport const moved = serverEnv;\n',
    );

    const reported = browserSurface(fixture).failures;
    for (const pkg of ["@alfred/jsonly", "@alfred/relocated"]) {
      if (!reported.some((failure) => failure.includes(pkg))) {
        failures.push(
          `browserSurface must report a reached root that resolves no scannable file (${pkg}), received ${JSON.stringify(reported)}`,
        );
      }
    }
  });

  // A reached package that keeps no sources in `src/`. `packages/config` is this
  // shape in the real repo, so the skip must be loud rather than silent.
  withFixture("alfred-web-boundaries-layout-", (fixture) => {
    initWorkspaceRepo(fixture);
    write(
      fixture,
      "apps/web/src/entry.ts",
      'import { ui } from "@alfred/fakeui";\nexport const used = ui;\n',
    );
    write(fixture, "packages/fakeui/package.json", '{ "name": "@alfred/fakeui" }\n');
    write(
      fixture,
      "packages/fakeui/lib/index.ts",
      'import { serverEnv } from "@alfred/env/server";\nexport const ui = serverEnv;\n',
    );

    const reported = browserSurface(fixture).failures;
    if (!reported.some((failure) => failure.includes("@alfred/fakeui"))) {
      failures.push(
        `browserSurface must report a reached package whose sources are not under src/, received ${JSON.stringify(reported)}`,
      );
    }
  });

  // The seed root is a constant, so a web app that moves leaves the walk with
  // nothing to follow. Scanning zero files must be red, not green.
  withFixture("alfred-web-boundaries-seed-", (fixture) => {
    initWorkspaceRepo(fixture);
    write(
      fixture,
      "apps/web/app/entry.ts",
      'import { pool } from "@alfred/db";\nexport const used = pool;\n',
    );

    const { files, failures: reported } = browserSurface(fixture);
    if (files.length > 0) {
      failures.push(
        `the seed fixture must resolve no files, received ${JSON.stringify(files)} — rewrite the fixture`,
      );
    }
    if (reported.length === 0) {
      failures.push(
        "browserSurface must report a missing browser entry root and an empty file list instead of passing vacuously",
      );
    }
  });

  return failures;
}

/**
 * The `apps/*` ruling: enumerated, never walked as a browser root, and classified by
 * hand. Each case is the event the declaration exists to catch.
 */
function appRulingFailures() {
  const failures = [];

  const expectSurfaceFailure = (label, needles, build) =>
    withFixture(`alfred-web-boundaries-${label}-`, (fixture) => {
      build(fixture);
      const reported = browserSurface(fixture).failures;
      for (const needle of needles) {
        if (reported.some((failure) => failure.includes(needle))) continue;
        failures.push(
          `${label}: browserSurface must report a failure naming ${JSON.stringify(needle)}, received ${JSON.stringify(reported)}`,
        );
      }
    });

  // Add-an-app. A second app is neither browser-bound nor Node-only until somebody
  // says so, and the message has to name both sets or the reader cannot act on it.
  expectSurfaceFailure(
    "unclassified-app",
    ["apps/marketing", "BROWSER_ENTRY_APPS", "NODE_ONLY_APPS"],
    (fixture) => {
      initWorkspaceRepo(fixture);
      write(fixture, "apps/web/src/entry.ts", "export const used = 1;\n");
      write(fixture, "apps/marketing/package.json", '{ "name": "marketing" }\n');
      write(
        fixture,
        "apps/marketing/src/main.ts",
        'import { serverEnv } from "@alfred/env/server";\nexport const leak = serverEnv;\n',
      );
    },
  );

  // Move-the-app. The seed is a declaration, so an app that moves or is renamed
  // leaves it pointing at a tree the enumeration does not list.
  expectSurfaceFailure("moved-app", ["BROWSER_ENTRY_APPS names apps/web"], (fixture) => {
    execFileSync("git", ["init", "--quiet"], { cwd: fixture });
    write(fixture, "pnpm-workspace.yaml", "packages:\n  - apps/*\n  - packages/*\n");
    write(fixture, "apps/client/package.json", '{ "name": "client" }\n');
    write(fixture, "apps/client/src/entry.ts", "export const used = 1;\n");
  });

  // Corroboration, and the only argument against a browser app misfiled as Node-only.
  // A stated blind spot: an SSR browser app has no `index.html` and slips through.
  expectSurfaceFailure("misfiled-node-app", ["apps/server", "index.html"], (fixture) => {
    initWorkspaceRepo(fixture);
    write(fixture, "apps/web/src/entry.ts", "export const used = 1;\n");
    write(fixture, "apps/server/package.json", '{ "name": "server" }\n');
    write(fixture, "apps/server/index.html", "<!doctype html>\n");
  });

  // The vacuous-pass guard, and the reason `listWorkspaces` returns failures at all:
  // an enumeration that resolves nothing must not leave this check reporting a
  // one-root surface it never verified.
  withFixture("alfred-web-boundaries-vacuous-", (fixture) => {
    execFileSync("git", ["init", "--quiet"], { cwd: fixture });
    write(
      fixture,
      "apps/web/src/entry.ts",
      'import { pool } from "@alfred/db";\nexport const used = pool;\n',
    );
    const reported = browserSurface(fixture).failures;
    if (!reported.some((failure) => failure.includes("pnpm-workspace.yaml"))) {
      failures.push(
        `a repository with no pnpm-workspace.yaml must make browserSurface report the refused enumeration, received ${JSON.stringify(reported)}`,
      );
    }
  });

  // `apps/*` now joins the package-name map. Inert in this repository, where the apps
  // are named `web` and `server` and `packageName` yields only `@alfred/*` — pinned so
  // that an app published under the scope becoming a derived root is a recorded
  // decision rather than an accident somebody discovers later.
  withFixture("alfred-web-boundaries-app-package-", (fixture) => {
    initWorkspaceRepo(fixture);
    write(
      fixture,
      "apps/web/src/entry.ts",
      'import { widget } from "@alfred/kiosk";\nexport const used = widget;\n',
    );
    write(fixture, "apps/kiosk/package.json", '{ "name": "@alfred/kiosk" }\n');
    write(fixture, "apps/kiosk/src/widget.ts", "export const widget = 1;\n");

    const { roots, failures: reported } = browserSurface(fixture);
    if (!roots.includes("apps/kiosk/src")) {
      failures.push(
        `an app whose manifest name is @alfred/* and which the browser surface imports at runtime must become a derived root, received ${JSON.stringify(roots)}`,
      );
    }
    // It is still an app, so it still needs classifying — being reached is not being
    // declared.
    if (!reported.some((failure) => failure.includes("apps/kiosk"))) {
      failures.push(
        `a reached app must still be reported as unclassified, received ${JSON.stringify(reported)}`,
      );
    }
  });

  return failures;
}

function writeDocs(fixture, { architecture, agents, architectureExtra, architectureSecondBlock }) {
  write(
    fixture,
    "docs/reference/architecture.md",
    [
      "Forbidden in `apps/web`: <!-- forbidden-runtime-packages:start -->",
      "",
      `- Any non-type import of ${architecture}.`,
      ...(architectureExtra ? [`- Any non-type import of ${architectureExtra}.`] : []),
      "",
      "<!-- forbidden-runtime-packages:end -->",
      "",
      ...(architectureSecondBlock
        ? [
            "For example, a package guide restates it as:",
            "",
            "```markdown",
            "<!-- forbidden-runtime-packages:start -->",
            `- Any non-type import of ${architectureSecondBlock}.`,
            "<!-- forbidden-runtime-packages:end -->",
            "```",
            "",
          ]
        : []),
    ].join("\n"),
  );
  write(
    fixture,
    "apps/web/AGENTS.md",
    `- It may import \`@alfred/contracts\`. <!-- forbidden-runtime-packages:start -->It must not import runtime values from ${agents}. <!-- forbidden-runtime-packages:end -->\n`,
  );
}

function list(packages) {
  return packages.map((pkg) => `\`${pkg}\``).join(", ");
}

function docListFailuresFailures() {
  const failures = [];
  const all = [...FORBIDDEN_RUNTIME_PACKAGES];

  const expect = (label, docs, predicate) =>
    withFixture("alfred-web-boundaries-docs-", (fixture) => {
      writeDocs(fixture, docs);
      const result = docListFailures(fixture);
      const problem = predicate(result);
      if (problem) failures.push(`docListFailures ${label}: ${problem}`);
    });

  expect(
    "must pass when both sites name the whole set",
    { architecture: list(all), agents: list(all) },
    (result) =>
      result.length === 0 ? null : `expected no failures, received ${JSON.stringify(result)}`,
  );

  // Wording, order and punctuation are the two sites' own business.
  expect(
    "must ignore reordering and rewording",
    {
      architecture: list([...all].reverse()),
      agents: `nothing at all from ${list([...all].reverse())} — none`,
    },
    (result) =>
      result.length === 0 ? null : `expected no failures, received ${JSON.stringify(result)}`,
  );

  const dropped = all[0];
  expect(
    "must catch a package missing from the prose",
    { architecture: list(all.slice(1)), agents: list(all) },
    (result) =>
      result.some((failure) => failure.includes(dropped) && failure.includes("architecture.md"))
        ? null
        : `expected a failure naming ${dropped} and architecture.md, received ${JSON.stringify(result)}`,
  );

  expect(
    "must catch a package the prose adds",
    { architecture: list(all), agents: list([...all, "@alfred/logging"]) },
    (result) =>
      result.some((failure) => failure.includes("@alfred/logging") && failure.includes("AGENTS.md"))
        ? null
        : `expected a failure naming @alfred/logging and AGENTS.md, received ${JSON.stringify(result)}`,
  );

  // The case above plants the extra package inside an existing sentence. This one
  // is the gesture a contributor actually makes — append one more bullet to the
  // list — which lands outside the block whenever the `:end` marker shares the
  // last bullet's line. The `architecture.md` fixture keeps that marker on its
  // own line for exactly this reason.
  expect(
    "must catch a package appended as a new bullet after the last one",
    { architecture: list(all), agents: list(all), architectureExtra: "`@alfred/logging`" },
    (result) =>
      result.some(
        (failure) => failure.includes("@alfred/logging") && failure.includes("architecture.md"),
      )
        ? null
        : `expected a failure naming @alfred/logging and architecture.md, received ${JSON.stringify(result)}`,
  );

  // A second marked block reads as gated while nothing compares it: the first
  // pair is the only one the set comparison ever sees. Here the first block is
  // correct and the second one drifts, so only the duplication itself can catch
  // it — which is the shape a worked example in a fenced code block takes.
  expect(
    "must catch a second marker pair the comparison never reads",
    {
      architecture: list(all),
      agents: list(all),
      architectureSecondBlock: list([...all.slice(1), "@alfred/logging"]),
    },
    (result) =>
      result.some(
        (failure) => failure.includes("architecture.md") && failure.includes("marker pair"),
      )
        ? null
        : `expected a failure naming architecture.md and the marker pair, received ${JSON.stringify(result)}`,
  );

  withFixture("alfred-web-boundaries-docs-", (fixture) => {
    write(fixture, "docs/reference/architecture.md", `Forbidden: ${list(all)}\n`);
    write(fixture, "apps/web/AGENTS.md", `Forbidden: ${list(all)}\n`);
    const result = docListFailures(fixture);
    if (!result.some((failure) => failure.includes("marker pair"))) {
      failures.push(
        `docListFailures must catch a site whose markers were removed, received ${JSON.stringify(result)}`,
      );
    }
  });

  return failures;
}

export function webBoundarySelfTestFailures() {
  return [
    ...runtimeBindingFailures(),
    ...inlineTypeClauseViolationFailures(),
    ...inlineTypeClauseRootFailures(),
    ...lexicalPositionFailures(),
    ...mentionedPackageRootFailures(),
    ...statementBoundaryFailures(),
    ...browserRootsFailures(),
    ...widenedScanFailures(),
    ...surfaceFailureFailures(),
    ...appRulingFailures(),
    ...docListFailuresFailures(),
  ];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const failures = webBoundarySelfTestFailures();
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }
  console.log("web-boundaries self-test passed.");
}
