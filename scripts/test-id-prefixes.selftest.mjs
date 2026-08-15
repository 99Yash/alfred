// Fixtures for the cross-file test-id-prefix check.
//
// The subject is a check, so "the check reports nothing" and "nothing is wrong"
// print the same sentence. Every arm below is therefore asserted in BOTH
// directions: a pair that must fire, and the near-miss pair that must not
// (.lessons/mechanical-review-gate-flags-deleted-doors-and-reads-no-arithmetic.md).
//
// A fixture supplies its own source text, so it can only ever drive the GRAMMAR.
// The last arm runs against the REAL repository root and asserts that discovery
// there is non-vacuous — five passing matcher fixtures beside a walk that
// collected zero files is the exact failure this shape exists to avoid
// (.lessons/a-hardcoded-scan-root-that-stops-resolving-is-a-violation-not-an-empty-walk.md).
// It asserts NON-EMPTINESS only. A drive that read the live tree's data would
// turn any unrelated test file into a self-test failure and take the gate down.
//
// `scripts/` has no CI test job and no tsconfig names it, so nothing here would
// run a `.test.ts`. The suite is driven by `check-test-id-prefixes.mjs` as a
// preamble, the wiring `check-script-paths.mjs` uses.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  crossFilePrefixCollisions,
  likePrefixPatterns,
  testStringLiterals,
} from "./test-id-prefixes.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The suite body every fixture file shares, parameterised by its prefix constant. */
function suite(prefix) {
  return [
    `const ID_PREFIX = ${JSON.stringify(prefix)};`,
    "",
    "before(async () => {",
    "  await db()",
    "    .delete(user)",
    "    .where(like(user.id, `${ID_PREFIX}%`));",
    "});",
    "",
    "const id = `${ID_PREFIX}${randomUUID()}`;",
    "",
  ].join("\n");
}

/** A file that mints ids but runs no cleanup — a victim, not a perpetrator. */
function victim(prefix) {
  return [
    `const ID_PREFIX = ${JSON.stringify(prefix)};`,
    "",
    "const id = `${ID_PREFIX}0`;",
    "",
  ].join("\n");
}

function write(root, relative, content) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/**
 * A git repository whose files git lists. Nothing is committed: discovery asks
 * for `--others --exclude-standard`, so untracked files count.
 */
function withFixture(files, body) {
  const fixture = mkdtempSync(join(tmpdir(), "alfred-test-id-prefixes-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: fixture });
    for (const [relative, content] of Object.entries(files)) write(fixture, relative, content);
    return body(fixture);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

/** Run the whole gate over a fixture: discovery, then the cross-file comparison. */
function scan(files) {
  return withFixture(files, (fixture) => {
    const { prefixes, failures, scanned } = likePrefixPatterns(fixture);
    const literals = testStringLiterals(fixture);
    return {
      prefixes,
      failures,
      scanned,
      collisions: crossFilePrefixCollisions(prefixes, literals),
    };
  });
}

function expectCollisions(label, result, count, failures) {
  if (result.collisions.length !== count) {
    failures.push(
      `${label}: expected ${count} collision(s), received ${JSON.stringify(
        result.collisions.map((c) => `${c.prefix.prefix} -> ${c.match.file}:${c.match.literal}`),
      )}`,
    );
  }
}

function expectNoFailures(label, result, failures) {
  if (result.failures.length > 0) {
    failures.push(
      `${label}: expected no discovery failure, received ${JSON.stringify(result.failures)}`,
    );
  }
}

/** @returns {string[]} one line per broken expectation; empty means the grammar holds. */
export function testIdPrefixSelfTestFailures() {
  /** @type {string[]} */
  const failures = [];

  // Arm 1 — a nested pair in two files is the bug. It must fire, and the
  // violation must name both files.
  const nested = scan({
    "packages/one/test/gateway.test.ts": suite("test-settings-"),
    "packages/one/test/tx-core.test.ts": victim("test-settings-tx-"),
  });
  expectNoFailures("nested cross-file pair", nested, failures);
  expectCollisions("nested cross-file pair", nested, 1, failures);
  if (nested.collisions.length === 1) {
    const collision = nested.collisions[0];
    if (collision.prefix.file !== "packages/one/test/gateway.test.ts") {
      failures.push(
        `nested cross-file pair: the perpetrator must be the gateway file, received ${collision.prefix.file}`,
      );
    }
    if (collision.match.file !== "packages/one/test/tx-core.test.ts") {
      failures.push(
        `nested cross-file pair: the victim must be the tx-core file, received ${collision.match.file}`,
      );
    }
  }

  // Arm 2 — the near-miss siblings the live tree carries. A rule cruder than
  // "one is a string-prefix of the other" reddens all six of these.
  const siblings = scan({
    "packages/one/test/mcp.test.ts": suite("test-mcp-"),
    "packages/one/test/broker.test.ts": suite("test-mcpbrk-"),
    "packages/one/test/list.test.ts": suite("test-mcplist-"),
    "packages/one/test/manager.test.ts": suite("test-mcpmgr-"),
    "packages/one/test/risk.test.ts": suite("test-mcprisk-"),
    "packages/one/test/seam.test.ts": suite("test-mcpseam-"),
    "packages/one/test/fold.test.ts": suite("test-gmail-kind-fold-"),
    "packages/one/test/refold.test.ts": suite("test-gmail-kind-refold-"),
  });
  expectNoFailures("legal siblings", siblings, failures);
  expectCollisions("legal siblings", siblings, 0, failures);
  if (siblings.prefixes.length !== 8) {
    failures.push(
      `legal siblings: expected 8 resolved prefixes, received ${siblings.prefixes.length}`,
    );
  }

  // Arm 3 — nesting inside ONE file is legal. Its hooks run in one process, in
  // order, so they cannot race.
  const sameFile = scan({
    "packages/one/test/resume-only.test.ts": [
      'const ID_PREFIX = "test-resume-only-";',
      'const CG_PREFIX = "test-resume-only-cg-";',
      "before(async () => {",
      "  await db().delete(user).where(like(user.id, `${ID_PREFIX}%`));",
      "  await db().delete(user).where(like(user.id, `${CG_PREFIX}%`));",
      "});",
      "",
    ].join("\n"),
  });
  expectNoFailures("same-file nesting", sameFile, failures);
  expectCollisions("same-file nesting", sameFile, 0, failures);

  // Arm 4 — a pattern the grammar cannot read must land in `failures`, not be
  // skipped. The check fails CLOSED, because an unread pattern is exactly the
  // one that could be reaching another suite.
  const opaque = scan({
    "packages/one/test/dynamic.test.ts": [
      "before(async () => {",
      "  await db().delete(user).where(like(user.id, buildPattern(scope)));",
      "});",
      "",
    ].join("\n"),
  });
  if (opaque.failures.length !== 1) {
    failures.push(
      `unresolvable pattern: expected exactly one discovery failure, received ${JSON.stringify(opaque.failures)}`,
    );
  } else if (!opaque.failures[0].includes("does not resolve to a static string")) {
    failures.push(
      `unresolvable pattern: the failure must say why, received ${JSON.stringify(opaque.failures[0])}`,
    );
  }
  if (opaque.prefixes.length !== 0) {
    failures.push(
      `unresolvable pattern: nothing may resolve, received ${JSON.stringify(opaque.prefixes)}`,
    );
  }

  // Arm 5 — a leading wildcard reaches everything and resolves to no prefix at
  // all, so it is a failure rather than a silently empty comparison.
  const wildcard = scan({
    "packages/one/test/greedy.test.ts": [
      'const ID_PREFIX = "test-greedy-";',
      "before(async () => {",
      "  await db().delete(user).where(like(user.id, `%${ID_PREFIX}%`));",
      "});",
      "",
    ].join("\n"),
  });
  if (!wildcard.failures.some((entry) => entry.includes("starts with a wildcard"))) {
    failures.push(
      `leading wildcard: expected a wildcard failure, received ${JSON.stringify(wildcard.failures)}`,
    );
  }

  // Arm 6 — the `// prefix-ok: <reason>` hatch, in both directions. It must
  // discharge the pair from either side, and a bare marker with no reason must
  // discharge nothing.
  const exempted = scan({
    "packages/one/test/gateway.test.ts": suite("test-settings-").replace(
      "`${ID_PREFIX}%`));",
      "`${ID_PREFIX}%`)); // prefix-ok: the tx suite reuses this row on purpose",
    ),
    "packages/one/test/tx-core.test.ts": victim("test-settings-tx-"),
  });
  expectCollisions("prefix-ok on the pattern line", exempted, 0, failures);
  const bare = scan({
    "packages/one/test/gateway.test.ts": suite("test-settings-").replace(
      "`${ID_PREFIX}%`));",
      "`${ID_PREFIX}%`)); // prefix-ok:",
    ),
    "packages/one/test/tx-core.test.ts": victim("test-settings-tx-"),
  });
  expectCollisions("prefix-ok with no reason", bare, 1, failures);

  // Arm 7 — an inline mint template is a victim too. `test-objstate-` carries no
  // named constant, so only the template head puts it in the census.
  const inlineMint = scan({
    "packages/one/test/owner.test.ts": suite("test-obj"),
    "packages/one/test/state.test.ts": "const id = `test-objstate-${randomUUID()}`;\n",
  });
  expectCollisions("inline mint template", inlineMint, 1, failures);

  // Arm 8 — the real root. Non-emptiness only.
  const live = likePrefixPatterns(ROOT);
  if (live.scanned === 0) {
    failures.push(
      "real root: the test-file walk found 0 files, so the live gate would enforce nothing",
    );
  }
  if (live.prefixes.length === 0) {
    failures.push("real root: no LIKE pattern resolved, so the live gate would compare nothing");
  }
  if (testStringLiterals(ROOT).length === 0) {
    failures.push(
      "real root: no test string literal was read, so the live gate would compare nothing",
    );
  }

  return failures;
}
