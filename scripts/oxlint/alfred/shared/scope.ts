import { relative, sep } from "node:path";

import { isSkippedPath } from "../../../consolidation-rules.mjs";

/**
 * True for a repo file the consolidation gate scanned: `.ts`/`.tsx` source that
 * {@link isSkippedPath} admits. Tests, evals, scripts, mocks and generated output
 * are out of scope. A rule that replaces a consolidation gate returns this from
 * `before()`, so its scope reads the same predicate as the table and needs no
 * `overrides` entry in `.oxlintrc.json`.
 */
export function inGateScope(filename: string, cwd: string): boolean {
  const file = repoFile(filename, cwd);

  return /\.tsx?$/.test(file) && !isSkippedPath(file);
}

/** The repo-relative `/`-separated path of the linted file, the form an owner list names. */
function repoFile(filename: string, cwd: string): string {
  return relative(cwd, filename).split(sep).join("/");
}

/**
 * True when the linted file is in the gate's scope and is not one of `owners`.
 * A rule that kept a consolidation gate's per-rule `owners` list returns this
 * from `before()`, so an owner is skipped whole, as the gate skipped it.
 */
export function inGateScopeExcept(
  filename: string,
  cwd: string,
  owners: ReadonlySet<string>,
): boolean {
  return inGateScope(filename, cwd) && !owners.has(repoFile(filename, cwd));
}
