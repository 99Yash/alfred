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
  const file = relative(cwd, filename).split(sep).join("/");

  return /\.tsx?$/.test(file) && !isSkippedPath(file);
}
