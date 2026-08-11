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

function runtimeBindingFailures() {
  const failures = [];
  // Pins today's behavior exactly. The widened surface must not change which
  // clause shapes count as a runtime binding.
  //
  // All seven cells are unchanged by the move to a token walk, and that is by
  // construction rather than by luck: `hasRuntimeBinding` itself is untouched,
  // and the walk hands it the same text the regex captured — the source between
  // the `import`/`export` keyword and the `from` token, so ` { type A } ` and
  // never ` { type A } from `. Widening the slice over the `from` token would
  // flip `{ type A }` to `true`.
  //
  // `{ type A }` must stay `false` here even though `verbatimModuleSyntax`
  // makes that form emit a real module load. That gap is its own queued change;
  // a scanner rewrite must not close it in passing, because a fence that moves
  // two rules at once cannot say which one a new failure came from.
  const cases = [
    ["type A", false],
    ["{ type A }", false],
    ["{ type A, type B }", false],
    ["{ type A, b }", true],
    ["{ A }", true],
    ["A", true],
    ["* as A", true],
  ];
  for (const [clause, expected] of cases) {
    if (hasRuntimeBinding(clause) !== expected) {
      failures.push(`hasRuntimeBinding("${clause}") must be ${expected}, received ${!expected}`);
    }
  }
  return failures;
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

    const violations = findViolations(join(fixture, "sample.ts"));
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
    execFileSync("git", ["init", "--quiet"], { cwd: fixture });
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
    execFileSync("git", ["init", "--quiet"], { cwd: fixture });
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
      const violations = findViolations(join(fixture, "sample.ts"));
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
  execFileSync("git", ["init", "--quiet"], { cwd: fixture });

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
      .files.filter((file) => findViolations(join(fixture, file)).length > 0)
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
    execFileSync("git", ["init", "--quiet"], { cwd: fixture });
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
    execFileSync("git", ["init", "--quiet"], { cwd: fixture });
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
    execFileSync("git", ["init", "--quiet"], { cwd: fixture });
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
    ...lexicalPositionFailures(),
    ...mentionedPackageRootFailures(),
    ...statementBoundaryFailures(),
    ...browserRootsFailures(),
    ...widenedScanFailures(),
    ...surfaceFailureFailures(),
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
