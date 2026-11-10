// Git pre-commit: applies `scripts/autofix.mjs` to the staged files, so a commit
// from any tool (Claude Code, Codex, a shell) does not carry a formatting error or
// a lint error with a safe fix.
//
// A file that is staged in full is fixed and staged again. A file with unstaged
// changes too is only checked: to stage the fix would also stage the user's
// unstaged hunks. The hook never blocks a commit. `pnpm check` and CI still
// decide; this only removes the faults a tool can fix with no judgment.
//
// Installed by `pnpm hooks:install`. Exits 0 on every path.

import { spawnSync } from "node:child_process";
import { autofix } from "../autofix.mjs";

process.on("uncaughtException", (error) => {
  console.error(`pre-commit autofix skipped: ${error instanceof Error ? error.message : error}`);
  process.exit(0);
});

/** @param {string[]} args */
function git(args) {
  const run = spawnSync("git", args, { encoding: "utf8" });

  if (run.status !== 0) throw new Error(`git ${args.join(" ")} exited ${run.status}`);

  return run.stdout;
}

/** @param {string} out NUL-separated `git diff --name-only -z` output */
const paths = (out) => out.split("\0").filter(Boolean);

const root = git(["rev-parse", "--show-toplevel"]).trim();

const staged = paths(git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]));

const unstaged = new Set(paths(git(["diff", "--name-only", "-z"])));

const whole = staged.filter((f) => !unstaged.has(f));

const partial = staged.filter((f) => unstaged.has(f));

if (whole.length > 0) {
  autofix(root, whole, { timeoutMs: 60_000 });

  const changed = new Set(paths(git(["diff", "--name-only", "-z", "--", ...whole])));

  if (changed.size > 0) {
    git(["add", "--", ...changed]);
    console.log(`pre-commit autofix: formatted or fixed ${changed.size} file(s).`);
  }
}

if (partial.length > 0) {
  console.log(
    `pre-commit autofix: ${partial.length} file(s) also have unstaged changes, so they were not fixed. Run \`pnpm format\` and \`pnpm lint:fix\` before you push:\n  ${partial.join("\n  ")}`,
  );
}
