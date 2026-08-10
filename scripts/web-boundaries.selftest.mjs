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
  browserSourceFiles,
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
      failures.push(
        `hasRuntimeBinding("${clause}") must be ${expected}, received ${!expected}`,
      );
    }
  }
  return failures;
}

/** A fixture repo: a web app, a reachable chain, a cycle, and two decoys. */
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

  workspace(fixture, "fake", { "b.ts": 'export { deep as thing } from "@alfred/deeper";\n' });
  // Closes a cycle back to `fake`; the walk must terminate.
  workspace(fixture, "deeper", { "c.ts": 'import "@alfred/fake";\nexport const deep = 1;\n' });
  workspace(fixture, "typeonly", { "t.ts": "export type Shape = { id: string };\n" });
  workspace(fixture, "db", { "d.ts": "export const pool = 1;\n" });
  workspace(fixture, "unreached", { "u.ts": "export const nobody = 1;\n" });
}

function browserRootsFailures() {
  return withFixture("alfred-web-boundaries-roots-", (fixture) => {
    const failures = [];
    buildReachabilityFixture(fixture);

    const roots = browserRoots(fixture);
    const expected = ["apps/web/src", "packages/deeper/src", "packages/fake/src"];
    if (JSON.stringify(roots) !== JSON.stringify(expected)) {
      failures.push(
        `browserRoots must follow runtime @alfred/* bindings transitively, skip forbidden and type-only packages, and terminate on a cycle: expected ${JSON.stringify(expected)}, received ${JSON.stringify(roots)}`,
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
    // Same leak, in a package nothing reaches: the fence follows the bundle, so
    // this one must stay unreported.
    write(
      fixture,
      "packages/unreached/src/leak.ts",
      'import { serverEnv } from "@alfred/env/server";\nexport const leak = serverEnv;\n',
    );

    const flagged = browserSourceFiles(fixture)
      .filter((file) => findViolations(join(fixture, file)).length > 0)
      .sort();
    // `entry.ts` is the old surface's own catch (it binds `@alfred/db`); the
    // second entry is the one a scan fixed at `apps/web/src` cannot see.
    const expected = ["apps/web/src/entry.ts", "packages/fake/src/leak.ts"];
    if (JSON.stringify(flagged) !== JSON.stringify(expected)) {
      failures.push(
        `the scan must cover every browser-reachable package and nothing else: expected ${JSON.stringify(expected)}, received ${JSON.stringify(flagged)}`,
      );
    }
    return failures;
  });
}

function writeDocs(fixture, { architecture, agents }) {
  write(
    fixture,
    "docs/reference/architecture.md",
    `Forbidden in \`apps/web\`: <!-- forbidden-runtime-packages:start -->\n\n- Any non-type import of ${architecture}. <!-- forbidden-runtime-packages:end -->\n`,
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

  expect("must pass when both sites name the whole set", { architecture: list(all), agents: list(all) }, (result) =>
    result.length === 0 ? null : `expected no failures, received ${JSON.stringify(result)}`,
  );

  // Wording, order and punctuation are the two sites' own business.
  expect(
    "must ignore reordering and rewording",
    { architecture: list([...all].reverse()), agents: `nothing at all from ${list([...all].reverse())} — none` },
    (result) => (result.length === 0 ? null : `expected no failures, received ${JSON.stringify(result)}`),
  );

  const dropped = all[0];
  expect("must catch a package missing from the prose", { architecture: list(all.slice(1)), agents: list(all) }, (result) =>
    result.some((failure) => failure.includes(dropped) && failure.includes("architecture.md"))
      ? null
      : `expected a failure naming ${dropped} and architecture.md, received ${JSON.stringify(result)}`,
  );

  expect("must catch a package the prose adds", { architecture: list(all), agents: list([...all, "@alfred/logging"]) }, (result) =>
    result.some((failure) => failure.includes("@alfred/logging") && failure.includes("AGENTS.md"))
      ? null
      : `expected a failure naming @alfred/logging and AGENTS.md, received ${JSON.stringify(result)}`,
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
    ...browserRootsFailures(),
    ...widenedScanFailures(),
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
