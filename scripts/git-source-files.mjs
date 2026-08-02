import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * List repository source files that local preflight checks must inspect.
 *
 * The collector includes tracked files. The regression self-test also requires
 * new untracked files, because CI sees those files after they are committed.
 * Ignored files stay outside the check surface.
 */
export function listGitSourceFiles(patterns, cwd = process.cwd()) {
  return execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...patterns],
    {
      cwd,
      encoding: "utf8",
    },
  )
    .split("\n")
    .filter(Boolean)
    .filter((file) => existsSync(resolve(cwd, file)))
    .sort();
}
