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
//     process, in order, so two prefixes declared in ONE file cannot race. Two
//     separate facts, because reading either one alone has already misled two
//     review rounds:
//       (a) A live file DOES carry a same-file nested pair.
//           `packages/http/test/replicache/resume-only.test.ts:162-163` mints
//           `test-resume-only-${randomUUID()}` and
//           `test-resume-only-cg-${randomUUID()}` in one file, and the first is a
//           string-prefix of the second. So the exemption is not dead code; it is
//           what keeps that file green.
//       (b) No live file carries such a pair where the SHORTER side owns a `like`
//           cleanup — measured at 0 across all 40 patterns, and that same
//           `resume-only.test.ts` holds no `like(` and no `…PREFIX…` constant at
//           all. So no live file demonstrates the RACE the exemption forgives,
//           and that half of the rule rests on how the runner schedules
//           processes, not on an example you can open.
//
// What the comparison reads, exactly. It is deliberately blind to which table or
// column a pattern targets, so it can over-report there, and the
// `// prefix-ok: <reason>` hatch discharges such a false positive in one line,
// mirroring `path-ok` in `script-paths.mjs` and `drift-ok` in
// `check-consolidation-drift.mjs`. If the hatch is ever needed more than about
// twice, the grammar is wrong and should narrow to id-mint sites instead.
//
// It can also UNDER-report, and the claim is therefore narrow rather than total:
//   - The PATTERN side fails closed. A `like(…)` pattern the grammar cannot read
//     is a `failures` entry, so it stops the build instead of being skipped.
//   - The DECLARATION side fails closed for anything that names itself a prefix.
//     A `const …PREFIX…` or an imported binding whose value does not resolve to a
//     static string is a `failures` entry too.
//   - The rest of the LITERAL side is best-effort. It reads plain string
//     literals, template heads, and `const` values resolved through other
//     constants of the same file. A row id assembled at run time out of values
//     this grammar cannot read is not in the census, and no check can put it
//     there. Name such a constant `…PREFIX…` and the previous rule catches it.
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

/** `const NAME = <expression>` — the id-prefix declaration a suite writes. */
const CONST_DECLARATION =
  /(?:^|\n)[ \t]*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=[ \t]*([^\n]*)/g;

/** `import { ID_PREFIX } from "…"` — a prefix this file cannot resolve on its own. */
const IMPORT_CLAUSE = /(?:^|\n)[ \t]*import\s+([^;]*?)\s+from\s*["'][^"']+["']/g;

/**
 * A binding whose name says it holds a row-id prefix.
 *
 * Screaming snake case, because that is what a module-level constant is written
 * in and all 65 live prefixes obey it. A camel-case `…Prefix` is a function or a
 * local in this tree — `storedCompactionPrefix` and `cleanupChatMediaPrefix` are
 * helpers, not row prefixes — and reading those as declarations would spend the
 * `// prefix-ok:` hatch three times on the first run.
 */
const PREFIX_NAME = /^[A-Z0-9_]*PREFIX[A-Z0-9_]*$/;

/** An identifier, for a bare-name or concatenated `const` value. */
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** LIKE treats these as wildcards, so the literal prefix ends at the first one. */
const LIKE_WILDCARD = /[%_]/;

/**
 * The scan surface: every `.ts` / `.tsx` file that sits under a `test/` directory,
 * plus any `*.test.ts(x)` wherever it lives.
 *
 * `.test.ts` alone is too narrow. Forty near-identical `before()` cleanup hooks
 * invite extraction into `test/support/*.ts` — item 231 is exactly that proposal —
 * and a `like(…)` that moves there would leave the census with one pattern fewer
 * and no failure to show for it. A partial extraction takes 40 patterns to 39 and
 * still prints success, so the non-empty guard in the CLI cannot see it.
 */
export function isScanFile(file) {
  if (!file.endsWith(".ts") && !file.endsWith(".tsx")) return false;
  return /(?:^|\/)test\//.test(file) || /\.test\.tsx?$/.test(file);
}

/** Every file of the scan surface under the scan roots, sorted. */
export function testFiles(root) {
  return listGitSourceFiles(SCAN_ROOTS, root).filter(isScanFile);
}

/** Every `const NAME = …` declaration in one source text, with its line. */
function constDeclarations(source) {
  /** @type {{ name: string, line: number, expression: string }[]} */
  const declarations = [];
  for (const match of source.matchAll(CONST_DECLARATION)) {
    const line =
      source.slice(0, match.index ?? 0).split("\n").length + (match[0][0] === "\n" ? 1 : 0);
    declarations.push({
      name: match[1] ?? "",
      line,
      expression: (match[2] ?? "").replace(/;\s*$/, "").trim(),
    });
  }
  return declarations;
}

/**
 * String-valued `const` declarations in one source text.
 *
 * Resolution runs to a fixed point, because a prefix is not always written in one
 * literal: `const BASE = "test-settings"` beside ``const ID_PREFIX = `${BASE}-tx-` ``
 * is the original bug plus one indirection, and reading only the direct literal
 * puts neither `test-settings-tx-` nor any warning into the census.
 *
 * A name declared twice with different values resolves to nothing: an ambiguous
 * name must fail closed, not pick a winner.
 *
 * @returns {Map<string, string | null>} `null` marks an ambiguous name. A name
 *   that never resolved is absent.
 */
function stringConstants(declarations) {
  /** @type {Map<string, string | null>} */
  const constants = new Map();
  for (let pass = 0; pass <= declarations.length; pass += 1) {
    let changed = false;
    for (const declaration of declarations) {
      if (constants.get(declaration.name) === null) continue;
      const value = staticString(declaration.expression, constants);
      if (value === null) continue;
      const known = constants.get(declaration.name);
      if (known === undefined) {
        constants.set(declaration.name, value);
        changed = true;
      } else if (known !== value) {
        constants.set(declaration.name, null);
        changed = true;
      }
    }
    if (!changed) break;
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

/** The operands of a top-level `+` chain, or `null` when there is no `+` at all. */
function splitConcatenation(text) {
  const operands = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "(" || character === "[" || character === "{") depth += 1;
    else if (character === ")" || character === "]" || character === "}") depth -= 1;
    else if (character === "`" || character === '"' || character === "'") {
      const end = text.indexOf(character, index + 1);
      if (end === -1) return null;
      index = end;
    } else if (character === "+" && depth === 0) {
      operands.push(text.slice(start, index));
      start = index + 1;
    }
  }
  if (operands.length === 0) return null;
  operands.push(text.slice(start));
  return operands;
}

/** A whole template literal, rather than two of them with a `+` between. */
function isWholeTemplate(text) {
  if (text.length < 2 || !text.startsWith("`") || !text.endsWith("`")) return false;
  const body = text.slice(1, -1);
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === "\\") index += 1;
    else if (body[index] === "`") return false;
  }
  return true;
}

/**
 * The static string an expression denotes, or `null` when it is not static.
 *
 * Handles the forms the tree writes — a plain literal, a bare constant name, a
 * `+` concatenation of those, and a template whose every interpolation is a
 * string `const` of the same file. Everything else is deliberately unresolvable,
 * so the caller reports it rather than skipping it.
 */
function staticString(expression, constants) {
  const text = expression.trim();
  const plain = /^(["'])((?:[^"'\\]|\\.)*)\1$/.exec(text);
  if (plain) return plain[2] ?? "";
  if (IDENTIFIER.test(text)) {
    const value = constants.get(text);
    return value === null || value === undefined ? null : value;
  }
  if (!isWholeTemplate(text)) {
    const operands = splitConcatenation(text);
    if (operands === null) return null;
    let joined = "";
    for (const operand of operands) {
      const value = staticString(operand, constants);
      if (value === null) return null;
      joined += value;
    }
    return joined;
  }

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
 * Every reason one file's row-id prefixes could not be read.
 *
 * A pattern that does not resolve is reported by the caller. This is the other
 * half, and it is the half that used to be silent: a DECLARATION that does not
 * resolve puts no literal into the census, so the pair it belongs to is compared
 * against nothing and the walk still prints success. The rule is narrow on
 * purpose — a name has to say it is a prefix — because a test file writes many
 * dynamic strings that mint no row at all.
 */
function unreadablePrefixDeclarations(file, source, declarations, constants) {
  const failures = [];
  const lines = source.split("\n");
  for (const declaration of declarations) {
    if (!PREFIX_NAME.test(declaration.name)) continue;
    const value = constants.get(declaration.name);
    if (value !== null && value !== undefined) continue;
    if (EXEMPTION.test(lines[declaration.line - 1] ?? "")) continue;
    failures.push(
      `${file}:${declaration.line}: the prefix constant ${declaration.name} = ${JSON.stringify(declaration.expression)} does not resolve to one static string, so the rows it mints are outside the census\n` +
        "    Fix: declare it as a plain string literal, or build it from string `const`s of the same file, or append `// prefix-ok: <reason>` to the line.",
    );
  }
  for (const clause of source.matchAll(IMPORT_CLAUSE)) {
    const imported = (clause[1] ?? "").match(/[A-Za-z_$][\w$]*/g) ?? [];
    const line =
      source.slice(0, clause.index ?? 0).split("\n").length + (clause[0][0] === "\n" ? 1 : 0);
    if (EXEMPTION.test(lines[line - 1] ?? "")) continue;
    for (const name of imported) {
      if (!PREFIX_NAME.test(name) || constants.has(name)) continue;
      failures.push(
        `${file}:${line}: the prefix ${name} is imported, so this file's rows cannot be read from it\n` +
          "    Fix: declare the prefix in the file that mints the rows, or append `// prefix-ok: <reason>` to the import.",
      );
    }
  }
  return failures;
}

/**
 * Resolved `LIKE` patterns across the test tree, plus every reason the walk could
 * not read a file's patterns or its prefix declarations.
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
    const declarations = constDeclarations(source);
    const constants = stringConstants(declarations);
    failures.push(...unreadablePrefixDeclarations(file, source, declarations, constants));
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
 * Every static string one source text writes, in one pass over its characters.
 *
 * A per-line regex cannot do this. It has to exclude the other quote character
 * from a literal's body, so `const note = "don't";` pairs the apostrophe with the
 * NEXT quote on the line and swallows whatever sits between them — including a
 * prefix declared right after it. One scanner that tracks the state instead
 * cannot mis-pair, and it reads comments, escapes and nested templates on the
 * way.
 *
 * A template contributes its static HEAD only. That head is where a row id
 * starts; text after an interpolation cannot begin one.
 *
 * @returns {{ line: number, value: string }[]}
 */
function staticStrings(source) {
  /** @type {{ line: number, value: string }[]} */
  const found = [];
  /** Brace depth inside each open `${ … }`, innermost last. */
  const templates = [];
  let index = 0;
  let line = 1;

  /** Consume template text from `index`, emitting it only when it is the head. */
  const readTemplateText = (emit) => {
    const startLine = line;
    let value = "";
    while (index < source.length) {
      const character = source[index];
      if (character === "\\") {
        if (source[index + 1] === "\n") line += 1;
        value += source[index + 1] ?? "";
        index += 2;
        continue;
      }
      if (character === "`") {
        index += 1;
        break;
      }
      if (character === "$" && source[index + 1] === "{") {
        index += 2;
        templates.push(0);
        break;
      }
      if (character === "\n") line += 1;
      value += character;
      index += 1;
    }
    if (emit && value !== "") found.push({ line: startLine, value });
  };

  while (index < source.length) {
    const character = source[index];
    if (character === "\n") {
      line += 1;
      index += 1;
    } else if (character === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
    } else if (character === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") line += 1;
        index += 1;
      }
      index += 2;
    } else if (character === '"' || character === "'") {
      const startLine = line;
      let value = "";
      index += 1;
      while (index < source.length && source[index] !== character && source[index] !== "\n") {
        if (source[index] === "\\") {
          value += source[index + 1] ?? "";
          index += 2;
          continue;
        }
        value += source[index];
        index += 1;
      }
      if (source[index] === "\n") line += 1; // an unterminated literal ends at the line.
      index += 1;
      if (value !== "") found.push({ line: startLine, value });
    } else if (character === "`") {
      index += 1;
      readTemplateText(true);
    } else if (character === "{" && templates.length > 0) {
      templates[templates.length - 1] += 1;
      index += 1;
    } else if (character === "}" && templates.length > 0) {
      if (templates[templates.length - 1] === 0) {
        templates.pop();
        index += 1;
        readTemplateText(false);
      } else {
        templates[templates.length - 1] -= 1;
        index += 1;
      }
    } else {
      index += 1;
    }
  }
  return found;
}

/**
 * Every static string a scanned test file writes, with `// prefix-ok:` lines
 * removed.
 *
 * Three shapes count, because all three mint ids: the `const ID_PREFIX = "…"` the
 * constant-carrying suites declare, the static head of an inline mint template
 * such as `` `test-objstate-${randomUUID()}` ``, and a prefix assembled out of
 * other constants of the same file. A suite that cleans up by `inArray` still
 * owns rows another suite's `LIKE` can delete, so it belongs on this side of the
 * comparison even though it runs no `LIKE` of its own.
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
    const lines = source.split("\n");
    const seen = new Set();
    for (const { line, value } of staticStrings(source)) {
      if (EXEMPTION.test(lines[line - 1] ?? "")) continue;
      literals.push({ file, line, literal: value });
      seen.add(value);
    }
    // A constant assembled from other constants has no literal of its own.
    const declarations = constDeclarations(source);
    const constants = stringConstants(declarations);
    for (const declaration of declarations) {
      const value = constants.get(declaration.name);
      if (value === null || value === undefined || value === "" || seen.has(value)) continue;
      if (EXEMPTION.test(lines[declaration.line - 1] ?? "")) continue;
      literals.push({ file, line: declaration.line, literal: value });
      seen.add(value);
    }
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
 * One collision per pattern and victim file, not per literal. A victim writes its
 * prefix once as a constant and again inside every id it mints from it, and the
 * fix is one rename either way, so repeating the pair for each id would report
 * the same bug several times over.
 *
 * @returns {Collision[]}
 */
export function crossFilePrefixCollisions(prefixes, literals) {
  /** @type {Collision[]} */
  const collisions = [];
  const reported = new Set();
  for (const prefix of prefixes) {
    for (const match of literals) {
      if (match.file === prefix.file) continue;
      if (!match.literal.startsWith(prefix.prefix)) continue;
      const pair = `${prefix.file}:${prefix.line} -> ${match.file}`;
      if (reported.has(pair)) continue;
      reported.add(pair);
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
