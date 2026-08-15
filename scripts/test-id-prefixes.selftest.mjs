// Fixtures for the cross-file test-id-prefix check.
//
// The subject is a check, so "the check reports nothing" and "nothing is wrong"
// print the same sentence. Every arm below is therefore asserted in BOTH
// directions: a pair that must fire, and the near-miss pair that must not
// (.lessons/mechanical-review-gate-flags-deleted-doors-and-reads-no-arithmetic.md).
//
// A fixture supplies its own source text, so it can only ever drive the GRAMMAR.
// The last arm runs against the REAL repository root, because passing matcher
// fixtures beside a walk that collected the wrong files is the exact failure this
// shape exists to avoid
// (.lessons/a-hardcoded-scan-root-that-stops-resolving-is-a-violation-not-an-empty-walk.md).
// Non-emptiness is NOT enough there: deleting `"apps"` from `SCAN_ROOTS` leaves
// every fixture green while the live walk quietly loses ten files, and a count
// the walk produced about itself cannot catch that
// (.lessons/test-force-exit-drops-a-suite-while-the-job-exits-0.md). So the arm
// enumerates the surface a SECOND time, from the repository root with no
// pathspec, and demands the two agree file for file. It still reads no live
// file's DATA — that would turn any unrelated test file into a self-test failure
// and take the gate down.
//
// The scan surface has TWO axes and each one needs its own witness. Arm 13 audits
// the ROOTS. It cannot audit the PREDICATE, because a narrowed predicate narrows
// both of its enumerations at once and they keep agreeing — so arm 12 pins
// `isScanFile` against a hand-written table of paths, and arm 13's second
// enumeration uses `inScanSurface`, a separate spelling that never calls it.
//
// `scripts/` has no CI test job and no tsconfig names it, so nothing here would
// run a `.test.ts`. The suite is driven by `check-test-id-prefixes.mjs` as a
// preamble, the wiring `check-script-paths.mjs` uses.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  crossFilePrefixCollisions,
  isScanFile,
  likePrefixPatterns,
  testFiles,
  testStringLiterals,
} from "./test-id-prefixes.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * A SECOND spelling of the scan surface, written for arm 13 alone.
 *
 * It must never call `isScanFile`, and it must not share its regexes. An audit
 * that filters both of its enumerations through the predicate it audits has no
 * witness: drop `.tsx` from `isScanFile` and both sides lose every `apps/web`
 * `.tsx` test together, so they still agree file for file, `pnpm check` stays
 * green, and the live walk quietly stops reading those files. Path segments are
 * compared here as segments, and the two test-file suffixes are written out one
 * by one, so a narrowing on either axis makes the two disagree.
 */
function inScanSurface(file) {
  const segments = file.split("/");
  const name = segments[segments.length - 1] ?? "";
  if (!name.endsWith(".ts") && !name.endsWith(".tsx")) return false;
  if (segments.slice(0, -1).includes("test")) return true;
  return name.endsWith(".test.ts") || name.endsWith(".test.tsx");
}

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
    "packages/one/test/one-process.test.ts": [
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

  // Arm 8 — a `like()` cleanup that has moved OUT of a `.test.ts` file still
  // counts. Item 231 proposes exactly that extraction for 40 near-identical
  // hooks, and a surface of `.test.ts` alone would lose each one silently.
  const support = scan({
    "packages/one/test/support/row-scope.ts": suite("test-settings-"),
    "packages/one/test/tx-core.test.ts": victim("test-settings-tx-"),
  });
  expectNoFailures("cleanup in a support file", support, failures);
  expectCollisions("cleanup in a support file", support, 1, failures);
  if (support.scanned !== 2) {
    failures.push(
      `cleanup in a support file: expected 2 scanned files, received ${support.scanned}`,
    );
  }

  // Arm 9 — the original bug plus one indirection. The prefix is assembled from
  // another constant, so it is written nowhere as a literal. Reading only direct
  // literals reports 0 collisions AND 0 failures, which is the fail-open the
  // header claims cannot happen.
  const assembled = scan({
    "packages/one/test/gateway.test.ts": suite("test-settings-"),
    "packages/one/test/tx-core.test.ts": [
      'const BASE = "test-settings";',
      "const ID_PREFIX = `${BASE}-tx-`;",
      "const id = `${ID_PREFIX}${randomUUID()}`;",
      "",
    ].join("\n"),
  });
  expectNoFailures("assembled prefix", assembled, failures);
  expectCollisions("assembled prefix", assembled, 1, failures);
  const concatenated = scan({
    "packages/one/test/gateway.test.ts": suite("test-settings-"),
    "packages/one/test/tx-core.test.ts": [
      'const BASE = "test-settings";',
      'const ID_PREFIX = BASE + "-tx-";',
      "",
    ].join("\n"),
  });
  expectCollisions("concatenated prefix", concatenated, 1, failures);

  // Arm 10 — a prefix this file cannot resolve is a `failures` entry, on the
  // DECLARATION side as well as the pattern side. An imported prefix is the
  // shape that reaches furthest: the census would hold nothing for the whole
  // file and say nothing about it.
  const imported = scan({
    "packages/one/test/gateway.test.ts": suite("test-settings-"),
    "packages/one/test/tx-core.test.ts": [
      'import { ID_PREFIX } from "./support/ids";',
      "",
      "const id = `${ID_PREFIX}${randomUUID()}`;",
      "",
    ].join("\n"),
  });
  if (!imported.failures.some((entry) => entry.includes("is imported"))) {
    failures.push(
      `imported prefix: expected an unreadable-declaration failure, received ${JSON.stringify(imported.failures)}`,
    );
  }
  const dynamic = scan({
    "packages/one/test/dynamic-prefix.test.ts": [
      "const ID_PREFIX = `test-dyn-${process.pid}-`;",
      "",
    ].join("\n"),
  });
  if (!dynamic.failures.some((entry) => entry.includes("does not resolve to one static string"))) {
    failures.push(
      `dynamic prefix: expected an unreadable-declaration failure, received ${JSON.stringify(dynamic.failures)}`,
    );
  }

  // Arm 11 — an apostrophe must not swallow the declaration beside it. A regex
  // that excludes the other quote from a literal's body pairs the `'` of "don't"
  // with the next `"` and reads `test-settings-tx-` as no literal at all.
  const apostrophe = scan({
    "packages/one/test/gateway.test.ts": suite("test-settings-"),
    "packages/one/test/tx-core.test.ts":
      'const note = "don\'t"; const ID_PREFIX = "test-settings-tx-";\n',
  });
  expectCollisions("apostrophe before a prefix", apostrophe, 1, failures);

  // Arm 12 — `isScanFile` pinned against a hand-written table, so a narrowing of
  // the predicate names itself. Arm 13 audits the scan ROOTS; this arm audits the
  // SUFFIX and DIRECTORY test, which arm 13 cannot see on its own — both of its
  // enumerations would otherwise narrow together and stay in agreement.
  /** @type {[string, boolean][]} */
  const scanSurfaceCases = [
    ["packages/assistant/test/preferences.behavior.test.ts", true],
    ["packages/assistant/test/support/db-backed.ts", true],
    ["packages/assistant/test/agent/start-run.test.ts", true],
    ["apps/web/test/chat/artifact-stream.test.ts", true],
    ["apps/web/test/chat/composer.test.tsx", true],
    ["apps/web/src/components/composer.test.tsx", true],
    ["packages/db/src/schema/agent.ts", false],
    ["apps/web/src/components/composer.tsx", false],
    ["packages/http/test/fixtures/pull-response.json", false],
    ["packages/http/test/support/README.md", false],
    ["scripts/test-id-prefixes.selftest.mjs", false],
    ["packages/assistant/testing/harness.ts", false],
  ];
  for (const [file, expected] of scanSurfaceCases) {
    if (isScanFile(file) !== expected) {
      failures.push(
        `scan surface: isScanFile(${JSON.stringify(file)}) is ${isScanFile(file)}, expected ${expected}. ` +
          "The scan surface was narrowed or widened; a narrowing drops files from the live walk in silence.",
      );
    }
  }

  // Arm 13 — the real root, counted twice by two different routes.
  const live = likePrefixPatterns(ROOT);
  if (live.prefixes.length === 0) {
    failures.push("real root: no LIKE pattern resolved, so the live gate would compare nothing");
  }
  if (testStringLiterals(ROOT).length === 0) {
    failures.push(
      "real root: no test string literal was read, so the live gate would compare nothing",
    );
  }
  const walked = testFiles(ROOT);
  const independent = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: ROOT, encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean)
    .filter(inScanSurface)
    .filter((file) => existsSync(resolve(ROOT, file)))
    .sort();
  if (independent.length === 0) {
    failures.push("real root: the independent enumeration found 0 files, so it proves nothing");
  }
  if (live.scanned !== walked.length) {
    failures.push(
      `real root: the walk reported ${live.scanned} scanned file(s) but listed ${walked.length}`,
    );
  }
  const seen = new Set(walked);
  const dropped = independent.filter((file) => !seen.has(file));
  const extra = walked.filter((file) => !independent.includes(file));
  if (dropped.length > 0) {
    failures.push(
      `real root: the walk missed ${dropped.length} file(s) of the scan surface, starting with ${dropped[0]}. ` +
        "A scan root was narrowed or removed; widen SCAN_ROOTS until the two enumerations agree.",
    );
  }
  if (extra.length > 0) {
    failures.push(
      `real root: the walk listed ${extra.length} file(s) the repository does not, starting with ${extra[0]}`,
    );
  }

  return failures;
}
