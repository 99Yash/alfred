// Repository-path literals hardcoded inside `scripts/`, and whether they still
// resolve.
//
// A checker that hardcodes a repo path degrades silently when the tree moves
// under it: the walk collects nothing, every matcher fixture still passes on the
// source text it supplies itself, and the gate reports success over zero files.
// `check-module-architecture.mjs` shipped in exactly that state
// (see .lessons/a-hardcoded-scan-root-that-stops-resolving-is-a-violation-not-an-empty-walk.md),
// and the table that repaired it can only prove the paths it LISTS — nothing
// forces the next literal an author adds to be listed at all.
//
// This module answers the unlisted case instead. It reads the source text of the
// scripts themselves, so a literal is in scope because it was written, not
// because someone remembered to declare it.
//
// The grammar is narrow on purpose, and each exclusion is a measured false
// positive rather than a convenience:
//   - `*.selftest.mjs` is outside the scan surface. A fixture writer's
//     `packages/one/src/index.ts` is SUPPOSED not to resolve in this repo.
//   - Template literals are out by construction. A path assembled at runtime has
//     no literal to resolve; only its plain-string base is covered.
//   - Bare root-level filenames are out by construction. `check-doc-symbols.mjs`
//     uses `"CLAUDE.md"` as a repo-root path at one line and as a segment joined
//     to a workspace directory 56 lines later, so any grammar that resolved bare
//     filenames against the root would be guessing. Those consumers fail loudly
//     on their own instead.
//   - Literals containing whitespace are out. Every repo path here is
//     space-free, and the error prose in these scripts quotes their own filenames
//     mid-sentence.
//   - Literals containing `:` are out. No path in this repo carries one, and the
//     arch checker's ratchet keys are `<file>:<specifier>` composites — a path
//     inside DATA, which is a different subject with a different owner.
//
// Escape hatch, mirroring `check-consolidation-drift.mjs`'s `// drift-ok`: a line
// carrying `// path-ok: <reason>` is exempt. The reason is required by the
// grammar and read by nobody — a deliberately-absent probe path needs it.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { listGitSourceFiles } from "./git-source-files.mjs";

/** @typedef {{ file: string, line: number, literal: string, target: string, exempt: string | null }} PathLiteral */

/** The scan surface. Git's pathspec `*` crosses `/`, so nested spikes are covered too. */
const SCAN_PATTERN = "scripts/*.mjs";

/** `// path-ok: <reason>`. A bare marker with no reason exempts nothing. */
const EXEMPTION = /\/\/\s*path-ok:[ \t]*(\S[^\n]*)/;

/** Plain single- or double-quoted literals. Backticks are deliberately absent. */
const STRING_LITERAL = /(["'])((?:[^"'\\\n]|\\.)*)\1/g;

/** A literal carrying one of these resolves by its directory prefix instead. */
const GLOB_META = /[*?[\]{}]/;

/**
 * First segments of tracked top-level directories — the grammar's prefix set.
 *
 * Derived from git rather than hardcoded: a meta-check that carried its own list
 * of top-level directories would be the very thing it polices.
 */
export function trackedTopLevelDirectories(root) {
  const directories = new Set();
  for (const file of listGitSourceFiles([], root)) {
    const slash = file.indexOf("/");
    if (slash > 0) directories.add(file.slice(0, slash));
  }
  return directories;
}

/** A JSDoc or comment line. Prose there quotes paths it never resolves. */
function isCommentLine(line) {
  const trimmed = line.trimStart();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

/**
 * The repo-relative path a literal claims, or `null` when the literal is not one.
 *
 * A glob resolves to the directory before its first metacharacter: `scripts/*.mjs`
 * claims that `scripts/` exists, which is the part a tree move can invalidate.
 */
function pathLiteralTarget(literal, trackedDirectories) {
  if (/[\s:]/.test(literal)) return null;
  if (!trackedDirectories.has(literal.split("/")[0])) return null;
  const meta = literal.search(GLOB_META);
  if (meta === -1) return literal;
  const cut = literal.lastIndexOf("/", meta);
  return cut > 0 ? literal.slice(0, cut) : null;
}

/**
 * Repo-path literals in the non-selftest `scripts/*.mjs` sources.
 *
 * `failures` carries discovery refusals — no `.mjs` file found, an unreadable
 * source, a prefix set that resolved to nothing — because an empty `literals`
 * list is otherwise indistinguishable from a clean one, which is the same
 * fail-open this whole check exists to close
 * (.lessons/shared-discovery-helper-collapses-n-independent-failures-into-one-vacuous-pass.md).
 *
 * @returns {{ literals: PathLiteral[], failures: string[] }}
 */
export function repoPathLiterals(root) {
  const failures = [];
  /** @type {PathLiteral[]} */
  const literals = [];

  const tracked = trackedTopLevelDirectories(root);
  if (tracked.size === 0) {
    failures.push(
      "no tracked top-level directory resolved, so every path literal is out of scope and the rule enforces nothing",
    );
  }

  const files = listGitSourceFiles([SCAN_PATTERN], root).filter(
    (file) => !file.endsWith(".selftest.mjs"),
  );
  if (files.length === 0) {
    failures.push(`the ${SCAN_PATTERN} walk yielded 0 scanned files, so the rule enforces nothing`);
  }

  for (const file of files) {
    let source;
    try {
      source = readFileSync(join(root, file), "utf8");
    } catch (error) {
      failures.push(
        `${file} could not be read (${error.message}), so its path literals went unchecked`,
      );
      continue;
    }
    source.split("\n").forEach((line, index) => {
      if (isCommentLine(line)) return;
      const exempt = EXEMPTION.exec(line)?.[1]?.trim() ?? null;
      for (const match of line.matchAll(STRING_LITERAL)) {
        const literal = match[2] ?? "";
        const target = pathLiteralTarget(literal, tracked);
        if (target === null) continue;
        literals.push({ file, line: index + 1, literal, target, exempt });
      }
    });
  }

  return { literals, failures };
}

/** Literals that resolve to nothing and carry no `// path-ok:`. */
export function unresolvedPathLiterals(literals, root) {
  const violations = [];
  for (const entry of literals) {
    if (entry.exempt !== null) continue;
    if (existsSync(join(root, entry.target))) continue;
    const prefix =
      entry.target === entry.literal
        ? ""
        : ` (its directory prefix ${JSON.stringify(entry.target)})`;
    violations.push(
      `${entry.file}:${entry.line}: the repository path ${JSON.stringify(entry.literal)} does not resolve${prefix}\n` +
        "    Fix: repoint the literal at the path it now means, or delete the rule it feeds.\n" +
        "    If the path is meant to be absent, append `// path-ok: <reason>` to the line.",
    );
  }
  return violations;
}
