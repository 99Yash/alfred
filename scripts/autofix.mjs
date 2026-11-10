// Applies the fixes that need no judgment to a list of files: `oxlint --fix` (the
// safe fixes only, never `--fix-suggestions`) and then `oxfmt --write`, in that
// order, so the file a fix touched is formatted too.
//
// Two callers share it: `.claude/hooks/lint-on-edit.mjs` (the one file an edit just
// wrote) and `scripts/git-hooks/pre-commit.mjs` (the fully staged files). A rule
// with no fixer, for example every `anti-slop/*` rule, is not changed here; the
// lint run still reports it.
//
// The format scope is read from the root `format` script, so this file and
// `pnpm format:check` cannot disagree about which files are formatted or which
// ignore files apply.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const LINTABLE = /\.(?:[cm]?[jt]sx?)$/;

/**
 * The `--ignore-path` flags and the targets of `pnpm format`.
 * @param {string} root
 * @returns {{ ignoreArgs: string[]; targets: string[] } | null}
 */
function formatScope(root) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const script = String(manifest.scripts?.format ?? "");

  if (!script.startsWith("oxfmt --write ")) return null;

  const words = script.split(/\s+/).slice(2);
  const ignoreArgs = [];
  const targets = [];

  for (let i = 0; i < words.length; i += 1) {
    if (words[i] === "--ignore-path") {
      ignoreArgs.push("--ignore-path", words[i + 1]);
      i += 1;
    } else {
      targets.push(words[i]);
    }
  }

  return { ignoreArgs, targets };
}

/** A target names a directory (`apps`) or one root file (`turbo.json`). */
function inScope(rel, targets) {
  return targets.some((t) => rel === t || rel.startsWith(`${t}/`));
}

/**
 * @param {string} root the worktree root
 * @param {string[]} files paths relative to `root`
 * @param {{ timeoutMs: number; lintArgs?: string[] }} options `lintArgs` are added to the
 *   fix run, so a caller can read the remaining diagnostics from the same run.
 * @returns {{ lint: import("node:child_process").SpawnSyncReturns<string> | null }}
 */
export function autofix(root, files, options) {
  const oxlint = join(root, "node_modules", ".bin", "oxlint");
  const oxfmt = join(root, "node_modules", ".bin", "oxfmt");
  const lintable = files.filter((f) => LINTABLE.test(f));
  /** @type {import("node:child_process").SpawnSyncReturns<string> | null} */
  let lint = null;

  if (lintable.length > 0 && existsSync(oxlint)) {
    lint = spawnSync(
      oxlint,
      [
        "--config",
        ".oxlintrc.json",
        "--fix",
        "--no-error-on-unmatched-pattern",
        ...(options.lintArgs ?? []),
        ...lintable,
      ],
      { cwd: root, encoding: "utf8", timeout: options.timeoutMs },
    );
  }

  const scope = formatScope(root);
  const formattable = scope ? files.filter((f) => inScope(f, scope.targets)) : [];

  if (scope && formattable.length > 0 && existsSync(oxfmt)) {
    spawnSync(
      oxfmt,
      ["--write", ...scope.ignoreArgs, "--no-error-on-unmatched-pattern", ...formattable],
      { cwd: root, encoding: "utf8", timeout: options.timeoutMs },
    );
  }

  return { lint };
}
