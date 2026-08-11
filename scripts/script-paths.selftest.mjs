// Fixtures for the `scripts/` path-literal meta-check.
//
// This suite exists because of the failure it is modelled on: five passing
// matcher fixtures coexisted with a walk that collected zero files, so the gate
// they drove enforced nothing
// (.lessons/a-hardcoded-scan-root-that-stops-resolving-is-a-violation-not-an-empty-walk.md).
// A fixture supplies its own source text, so it can only ever drive the MATCHER.
// The last two cases therefore run against the REAL repository root and assert
// that discovery is non-vacuous there.
//
// Both real-root cases assert NON-EMPTINESS only, never exact contents. A drive
// that reads the live tree's data turns any unrelated edit into a self-test
// failure and takes the whole gate down with it.
//
// `scripts/` has no CI test job and no tsconfig names it, so nothing would run a
// test file here. The suite is driven by `check-script-paths.mjs` as a preamble,
// the wiring `check-consolidation-drift.mjs` and `check-web-boundaries.mjs` use.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  repoPathLiterals,
  trackedTopLevelDirectories,
  unresolvedPathLiterals,
} from "./script-paths.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function write(root, relative, content) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/**
 * A git repository whose files git lists. Nothing is committed: discovery asks
 * for `--others --exclude-standard`, so untracked files count and ignored ones do
 * not — the same contract `workspaces.selftest.mjs` fixtures rely on.
 */
function withFixture(prefix, body) {
  const fixture = mkdtempSync(join(tmpdir(), prefix));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: fixture });
    return body(fixture);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

/** Run the whole gate over a fixture: discovery, then resolution. */
function scan(fixture) {
  const { literals, failures } = repoPathLiterals(fixture);
  return { literals, failures, violations: unresolvedPathLiterals(literals, fixture) };
}

function expectOneViolation(label, result, needles, failures) {
  if (result.violations.length !== 1) {
    failures.push(
      `${label}: expected exactly one violation, received ${JSON.stringify(result.violations)}`,
    );
    return;
  }
  for (const needle of needles) {
    if (!result.violations[0].includes(needle)) {
      failures.push(
        `${label}: the violation must name ${JSON.stringify(needle)}, received ${JSON.stringify(result.violations[0])}`,
      );
    }
  }
}

function expectNoViolation(label, result, failures) {
  if (result.violations.length > 0) {
    failures.push(`${label}: expected no violation, received ${JSON.stringify(result.violations)}`);
  }
}

function expectClean(label, result, failures) {
  if (result.failures.length > 0) {
    failures.push(
      `${label}: expected no discovery failure, received ${JSON.stringify(result.failures)}`,
    );
  }
}

function expectFailure(label, result, needle, failures) {
  if (!result.failures.some((failure) => failure.includes(needle))) {
    failures.push(
      `${label}: expected a discovery failure naming ${JSON.stringify(needle)}, received ${JSON.stringify(result.failures)}`,
    );
  }
}

/**
 * A fixture with one script and one real package directory, so `packages` and
 * `scripts` are both tracked top-level directories and the grammar's prefix set
 * is non-empty for reasons the case controls.
 */
function withScript(prefix, scriptRelative, thirdLine, body) {
  return withFixture(prefix, (fixture) => {
    write(fixture, "packages/live/src/index.ts", "export const live = 1;\n");
    write(
      fixture,
      scriptRelative,
      'import { join } from "node:path";\nconst ROOT = "/tmp";\n' + thirdLine + "\n",
    );
    return body(fixture);
  });
}

/** 1-4 — the matcher, and the exemption grammar it honours. */
function matcherFailures() {
  const failures = [];

  withScript(
    "alfred-script-paths-absent-",
    "scripts/x.mjs",
    'export const SCAN = join(ROOT, "packages/gone/src");',
    (fixture) => {
      const result = scan(fixture);
      expectClean("absent literal", result, failures);
      expectOneViolation(
        "absent literal",
        result,
        ["scripts/x.mjs:3", '"packages/gone/src"', "path-ok"],
        failures,
      );
    },
  );

  withScript(
    "alfred-script-paths-present-",
    "scripts/x.mjs",
    'export const SCAN = join(ROOT, "packages/live/src");',
    (fixture) => {
      const result = scan(fixture);
      expectClean("resolving literal", result, failures);
      expectNoViolation("resolving literal", result, failures);
      if (result.literals.length !== 1) {
        failures.push(
          `resolving literal: the literal must still be COLLECTED, or the next case proves nothing; received ${JSON.stringify(result.literals)}`,
        );
      }
    },
  );

  withScript(
    "alfred-script-paths-exempt-",
    "scripts/x.mjs",
    'export const SCAN = join(ROOT, "packages/gone/src"); // path-ok: probes a deliberately absent path',
    (fixture) => {
      const result = scan(fixture);
      expectClean("exempt literal", result, failures);
      expectNoViolation("exempt literal", result, failures);
    },
  );

  // The reason is what makes the hatch cost something to use. A bare marker is
  // the shape an author reaches for under pressure, so it must not work.
  withScript(
    "alfred-script-paths-reasonless-",
    "scripts/x.mjs",
    'export const SCAN = join(ROOT, "packages/gone/src"); // path-ok:',
    (fixture) => {
      const result = scan(fixture);
      expectClean("reasonless marker", result, failures);
      expectOneViolation(
        "reasonless marker",
        result,
        ["scripts/x.mjs:3", '"packages/gone/src"'],
        failures,
      );
    },
  );

  return failures;
}

/** 5-6 — the two exclusions the grammar states, pinned so silence is not read as coverage. */
function grammarNarrownessFailures() {
  const failures = [];

  // A fixture writer's paths are SUPPOSED not to resolve in the repo it runs in.
  // A resolving sibling script keeps discovery clean, so the case proves the file
  // was EXCLUDED rather than that the walk found nothing.
  withScript(
    "alfred-script-paths-selftest-",
    "scripts/x.mjs",
    'export const SCAN = join(ROOT, "packages/live/src");',
    (fixture) => {
      write(
        fixture,
        "scripts/y.selftest.mjs",
        'import { join } from "node:path";\nconst ROOT = "/tmp";\nexport const SCAN = join(ROOT, "packages/gone/src");\n',
      );
      const result = scan(fixture);
      expectClean("selftest excluded", result, failures);
      expectNoViolation("selftest excluded", result, failures);
      if (result.literals.length !== 1) {
        failures.push(
          `selftest excluded: only the non-selftest script may be scanned, received ${JSON.stringify(result.literals)}`,
        );
      }
    },
  );

  // A path assembled at runtime is invisible, and that is stated rather than fixed.
  withScript(
    "alfred-script-paths-template-",
    "scripts/x.mjs",
    "export const SCAN = join(ROOT, `packages/gone-${ROOT}/src`);",
    (fixture) => {
      const result = scan(fixture);
      expectClean("template literal", result, failures);
      expectNoViolation("template literal", result, failures);
      if (result.literals.length !== 0) {
        failures.push(
          `template literal: a template must collect nothing, received ${JSON.stringify(result.literals)}`,
        );
      }
    },
  );

  return failures;
}

/** 7 — discovery that finds nothing is a refusal, never an empty list. */
function discoveryRefusalFailures() {
  const failures = [];

  withFixture("alfred-script-paths-noscripts-", (fixture) => {
    write(fixture, "scripts/README.md", "no scripts here yet\n");
    const result = scan(fixture);
    expectFailure("zero .mjs files", result, "yielded 0 scanned files", failures);
    if (result.literals.length !== 0) {
      failures.push(
        `zero .mjs files: expected no literals, received ${JSON.stringify(result.literals)}`,
      );
    }
  });

  withFixture("alfred-script-paths-notree-", (fixture) => {
    write(fixture, "README.md", "a repository with no directories\n");
    const result = scan(fixture);
    expectFailure("empty prefix set", result, "no tracked top-level directory", failures);
    expectFailure("empty prefix set", result, "yielded 0 scanned files", failures);
  });

  return failures;
}

/**
 * 8-9 — the real root. Every case above supplies its own source text, so none of
 * them can tell whether the live walk collects anything at all.
 */
function realRootFailures() {
  const failures = [];

  const { literals, failures: discovery } = repoPathLiterals(ROOT);
  if (discovery.length > 0) {
    failures.push(`real root: discovery refused — ${JSON.stringify(discovery)}`);
  }
  if (literals.length === 0) {
    failures.push(
      "real root: the scripts/*.mjs walk collected 0 in-scope path literals, so the rule enforces nothing",
    );
  }

  const tracked = trackedTopLevelDirectories(ROOT);
  if (tracked.size === 0 || !tracked.has("scripts")) {
    failures.push(
      `real root: the grammar's prefix set must be non-empty and contain "scripts", or every literal is silently out of scope; received ${JSON.stringify([...tracked])}`,
    );
  }

  return failures;
}

export function scriptPathSelfTestFailures() {
  return [
    ...matcherFailures(),
    ...grammarNarrownessFailures(),
    ...discoveryRefusalFailures(),
    ...realRootFailures(),
  ];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const failures = scriptPathSelfTestFailures();
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }
  console.log("script-paths self-test passed.");
}
