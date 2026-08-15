// Row-id prefixes that DB-backed test suites delete with `LIKE '<prefix>%'`, and
// whether one suite's pattern reaches another suite's rows.
//
// Every DB-backed suite in this repo scopes its rows with an id prefix and clears
// residue in a `before()` hook with `db().delete(user).where(like(user.id,
// `${ID_PREFIX}%`))`. `tsx --test` runs test FILES as concurrent child processes
// against ONE database, so the hooks of two files interleave. When one file's
// prefix is a string-prefix of another file's prefix, the shorter pattern deletes
// the longer suite's rows mid-run — and the `user` delete cascades through 59 FK
// columns, so the failure surfaces in the OTHER file as a missing row.
//
// That is not hypothetical: `test-settings-` reached `test-settings-tx-<uuid>` and
// reddened `assistant-unit-tests` twice, on PR #828 and on `main` at `5a8d2061`.
// A rerun went green both times, which is what an interleaving-dependent failure
// looks like and why no amount of green CI is evidence here. The argument has to
// be structural, so this module is the structure.
//
// No runtime registry can close it. The two files are two OS processes; neither
// can see the other's prefix. Only a static read across files can, which is what
// this grammar does.
//
// The rule is exactly "one file's resolved LIKE prefix is a string-prefix of a
// string literal in a DIFFERENT file". Both halves are load-bearing:
//   - Anything cruder — "two prefixes share a stem" — reddens six legal pairs the
//     tree already carries: `test-mcp-` beside `test-mcpbrk-`, `test-mcplist-`,
//     `test-mcpmgr-`, `test-mcprisk-` and `test-mcpseam-`, and
//     `test-gmail-kind-fold-` beside `test-gmail-kind-refold-`. The trailing `-`
//     is what saves each one, and a string-prefix test reads it.
//   - Same-file pairs are LEGAL and must stay legal. One file's hooks run in one
//     process, in order, so `test-resume-only-` and `test-resume-only-cg-` in
//     `packages/http/test/replicache/resume-only.test.ts` cannot race.
//
// The comparison is deliberately blind to which table or column a pattern targets.
// That direction is the safe one — it can over-report, never under-report — and
// the `// prefix-ok: <reason>` hatch discharges a false positive in one line,
// mirroring `path-ok` in `script-paths.mjs` and `drift-ok` in
// `check-consolidation-drift.mjs`. If the hatch is ever needed more than about
// twice, the grammar is wrong and should narrow to id-mint sites instead.
//
// Prose the check does NOT enforce, stated once here: make two suites SIBLINGS
// under a shared stem (`test-settings-gw-` and `test-settings-tx-`), never parent
// and child. The check enforces the outcome, not the naming style.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { listGitSourceFiles } from "./git-source-files.mjs";

/** @typedef {{ file: string, line: number, prefix: string, pattern: string }} LikePrefix */
/** @typedef {{ file: string, line: number, literal: string }} TestLiteral */
/** @typedef {{ prefix: LikePrefix, match: TestLiteral }} Collision */

/**
 * The scan surface.
 *
 * Directory pathspecs, never a glob. A bare `**` pathspec is not glob-matched by
 * git at all — `*` already crosses `/` — so `packages/**\/*.test.ts` demands one
 * directory level and silently drops every flat file, which would make this gate
 * count wrong or count zero
 * (.lessons/git-pathspec-double-star-needs-glob-magic-or-it-drops-flat-files.md).
 * The suffix is filtered here instead.
 */
const SCAN_ROOTS = ["packages", "apps"];

/** `// prefix-ok: <reason>`. A bare marker with no reason exempts nothing. */
const EXEMPTION = /\/\/\s*prefix-ok:[ \t]*(\S[^\n]*)/;

/** The drizzle pattern operators. `notLike` cannot delete, but it can be read wrong. */
const LIKE_CALL = /\b(like|ilike|notLike|notIlike)\s*\(/g;

/** `const NAME = "value";` — the id-prefix declaration every suite writes. */
const CONST_STRING = /(?:^|\n)[ \t]*const\s+([A-Za-z_$][\w$]*)\s*=\s*(["'])((?:[^\\\n]|\\.)*?)\2/g;

/** Plain single- or double-quoted literals, one line at a time. */
const STRING_LITERAL = /(["'])((?:[^"'\\\n]|\\.)*)\1/g;

/** The static head of a template literal: `` `test-objstate-${randomUUID()}` ``. */
const TEMPLATE_HEAD = /`([^`\\$\n]*)\$\{/g;

/** LIKE treats these as wildcards, so the literal prefix ends at the first one. */
const LIKE_WILDCARD = /[%_]/;

/** A test file, by suffix rather than by pathspec glob. */
function isTestFile(file) {
  return file.endsWith(".test.ts") || file.endsWith(".test.tsx");
}

/** A JSDoc or comment line. Prose there quotes prefixes it never mints. */
function isCommentLine(line) {
  const trimmed = line.trimStart();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

/** Every test file under the scan roots, sorted. */
export function testFiles(root) {
  return listGitSourceFiles(SCAN_ROOTS, root).filter(isTestFile);
}

/**
 * String-valued `const` declarations in one source text.
 *
 * A name declared twice with different values resolves to nothing: an ambiguous
 * name must fail closed, not pick a winner.
 *
 * @returns {Map<string, string | null>} `null` marks an ambiguous name.
 */
function stringConstants(source) {
  /** @type {Map<string, string | null>} */
  const constants = new Map();
  for (const match of source.matchAll(CONST_STRING)) {
    const name = match[1];
    const value = match[3] ?? "";
    if (constants.has(name) && constants.get(name) !== value) constants.set(name, null);
    else constants.set(name, value);
  }
  return constants;
}

/** The argument list text of a call whose `(` sits at `open`, or `null` if unbalanced. */
function callArguments(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  return null;
}

/** Split an argument list on its top-level commas. */
function splitArguments(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "(" || character === "[" || character === "{") depth += 1;
    else if (character === ")" || character === "]" || character === "}") depth -= 1;
    else if (character === "," && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * The static string an expression denotes, or `null` when it is not static.
 *
 * Handles the two forms the tree writes — a plain literal and a template whose
 * every interpolation is a string `const` of the same file. Everything else is
 * deliberately unresolvable, so the caller reports it rather than skipping it.
 */
function staticString(expression, constants) {
  const text = expression.trim();
  const plain = /^(["'])((?:[^"'\\]|\\.)*)\1$/.exec(text);
  if (plain) return plain[2] ?? "";
  if (!text.startsWith("`") || !text.endsWith("`") || text.length < 2) return null;

  const body = text.slice(1, -1);
  let resolved = "";
  let index = 0;
  while (index < body.length) {
    const open = body.indexOf("${", index);
    if (open === -1) {
      resolved += body.slice(index);
      break;
    }
    resolved += body.slice(index, open);
    const close = body.indexOf("}", open);
    if (close === -1) return null;
    const name = body.slice(open + 2, close).trim();
    if (!constants.has(name)) return null;
    const value = constants.get(name);
    if (value === null || value === undefined) return null;
    resolved += value;
    index = close + 1;
  }
  return resolved;
}

/**
 * Resolved `LIKE` patterns across the test tree, plus the ones that did not
 * resolve.
 *
 * `failures` is not decoration. An empty `prefixes` list from a broken walk reads
 * exactly like a clean tree, which is the fail-open this check exists to close
 * (.lessons/shared-discovery-helper-collapses-n-independent-failures-into-one-vacuous-pass.md).
 * So a pattern the grammar cannot read stops the build instead of being skipped.
 *
 * @returns {{ prefixes: LikePrefix[], failures: string[], scanned: number }}
 */
export function likePrefixPatterns(root) {
  const failures = [];
  /** @type {LikePrefix[]} */
  const prefixes = [];

  const files = testFiles(root);
  if (files.length === 0) {
    failures.push(
      `the ${SCAN_ROOTS.join(" / ")} test-file walk yielded 0 files, so the rule enforces nothing`,
    );
  }

  for (const file of files) {
    let source;
    try {
      source = readFileSync(join(root, file), "utf8");
    } catch (error) {
      failures.push(
        `${file} could not be read (${error instanceof Error ? error.message : String(error)}), so its LIKE patterns went unchecked`,
      );
      continue;
    }
    const constants = stringConstants(source);
    for (const call of source.matchAll(LIKE_CALL)) {
      const open = (call.index ?? 0) + call[0].length - 1;
      const line = source.slice(0, call.index ?? 0).split("\n").length;
      const args = callArguments(source, open);
      if (args === null) {
        failures.push(`${file}:${line}: the ${call[1]}(…) call has no balanced argument list`);
        continue;
      }
      const parts = splitArguments(args);
      if (parts.length < 2) {
        failures.push(`${file}:${line}: the ${call[1]}(…) call has no pattern argument`);
        continue;
      }
      const source_line = source.split("\n")[line - 1] ?? "";
      if (EXEMPTION.test(source_line)) continue;
      const pattern = staticString(parts[1] ?? "", constants);
      if (pattern === null) {
        failures.push(
          `${file}:${line}: the ${call[1]}(…) pattern ${JSON.stringify((parts[1] ?? "").trim())} does not resolve to a static string, so its reach cannot be read\n` +
            "    Fix: build the pattern from a string `const` of the same file, or append `// prefix-ok: <reason>` to the line.",
        );
        continue;
      }
      const wildcard = pattern.search(LIKE_WILDCARD);
      const prefix = wildcard === -1 ? pattern : pattern.slice(0, wildcard);
      if (prefix === "") {
        failures.push(
          `${file}:${line}: the ${call[1]}(…) pattern ${JSON.stringify(pattern)} starts with a wildcard, so it matches every other suite's rows`,
        );
        continue;
      }
      prefixes.push({ file, line, prefix, pattern });
    }
  }

  return { prefixes, failures, scanned: files.length };
}

/**
 * Every static string a test file writes, with `// prefix-ok:` lines removed.
 *
 * Both shapes count, because both mint ids: the `const ID_PREFIX = "…"` the 56
 * constant-carrying suites declare, and the static head of an inline mint
 * template such as `` `test-objstate-${randomUUID()}` ``. A suite that cleans up
 * by `inArray` still owns rows another suite's `LIKE` can delete, so it belongs on
 * this side of the comparison even though it runs no `LIKE` of its own.
 *
 * @returns {TestLiteral[]}
 */
export function testStringLiterals(root) {
  /** @type {TestLiteral[]} */
  const literals = [];
  for (const file of testFiles(root)) {
    let source;
    try {
      source = readFileSync(join(root, file), "utf8");
    } catch {
      continue; // likePrefixPatterns reports the unreadable file; do not report it twice.
    }
    source.split("\n").forEach((line, index) => {
      if (isCommentLine(line)) return;
      if (EXEMPTION.test(line)) return;
      for (const match of line.matchAll(STRING_LITERAL)) {
        const literal = match[2] ?? "";
        if (literal !== "") literals.push({ file, line: index + 1, literal });
      }
      for (const match of line.matchAll(TEMPLATE_HEAD)) {
        const literal = match[1] ?? "";
        if (literal !== "") literals.push({ file, line: index + 1, literal });
      }
    });
  }
  return literals;
}

/**
 * Patterns that reach another file's ids.
 *
 * A prefix in file F is compared against literals in every file other than F.
 * Same-file pairs are legal by construction: one file's hooks run in one process,
 * in order.
 *
 * @returns {Collision[]}
 */
export function crossFilePrefixCollisions(prefixes, literals) {
  /** @type {Collision[]} */
  const collisions = [];
  for (const prefix of prefixes) {
    for (const match of literals) {
      if (match.file === prefix.file) continue;
      if (!match.literal.startsWith(prefix.prefix)) continue;
      collisions.push({ prefix, match });
    }
  }
  return collisions;
}

/** One human-readable violation per collision. */
export function formatCollision({ prefix, match }) {
  return (
    `${prefix.file}:${prefix.line}: the cleanup pattern ${JSON.stringify(`${prefix.pattern}`)} also matches ` +
    `${JSON.stringify(match.literal)}, written at ${match.file}:${match.line}\n` +
    "    These files run as concurrent tsx --test processes against one database, so the\n" +
    "    cleanup deletes rows the other suite still needs and the failure lands over there.\n" +
    "    Fix: rename the SHORTER prefix so the two are siblings under a shared stem\n" +
    "    (test-settings-gw- and test-settings-tx-), never parent and child.\n" +
    "    If the two strings are unrelated, append `// prefix-ok: <reason>` to either line."
  );
}
