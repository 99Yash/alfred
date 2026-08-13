// One conversion, shared by every preflight check that compares a path `tsc`
// printed against a path git listed.
//
// The two producers speak different path spaces. `git ls-files` prints
// repo-relative paths. `tsc --listFilesOnly` prints absolute REALPATHS, and a
// diagnostic prints a path relative to the run's cwd. A caller may spell the
// root through a symlink — `/tmp` is a link to `/private/tmp` on macOS, and
// `/var` to `/private/var`, so every scratch worktree and every `mkdtemp`
// fixture is reachable by two names. Compare the spaces directly and the sets
// are disjoint, so a check reports every file as unread while looking green in
// the tree that made it.
//
// Two scripts learned that separately and grew byte-near copies of the same
// per-call `realpathSync` fallback. The fallback answers the question one path
// at a time, which means a module keeps two spellings alive and a reader must
// hold both. Realpath the ROOT once instead, route every foreign path through
// this function, and the module holds one space.

import { relative, resolve } from "node:path";

/**
 * A path as `tsc` printed it — an absolute realpath from `--listFilesOnly`, or a
 * path relative to the run's cwd from a diagnostic — as a repo-relative path.
 *
 * `realRoot` must already be realpathed; both spellings of the root then collapse
 * onto the same string, which is what lets a `tsc`-printed set and a git-listed set
 * be compared as one set.
 *
 * A path outside `realRoot` becomes a `../…` string. That matches no git-listed
 * path, exactly as the absolute spelling did, so no caller's verdict moves.
 *
 * @param {string} realRoot
 * @param {string} printed
 * @returns {string}
 */
export function toRepoRelative(realRoot, printed) {
  return relative(realRoot, resolve(realRoot, printed));
}
