// Installs `.git/hooks/pre-commit`, which runs `scripts/git-hooks/pre-commit.mjs`
// from the worktree that makes the commit. It writes into the common git dir, so
// one install covers every worktree. A branch without the script commits with no
// change.
//
// It does not set `core.hooksPath`: the other hooks in `.git/hooks` stay active. It
// refuses to replace a `pre-commit` that it did not write.
//
// Usage: pnpm hooks:install

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const MARKER = "# installed by scripts/install-git-hooks.mjs";

const HOOK = `#!/bin/sh
${MARKER}
root="$(git rev-parse --show-toplevel)" || exit 0
script="$root/scripts/git-hooks/pre-commit.mjs"
[ -f "$script" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0
node "$script" || true
`;

const run = spawnSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8" });

if (run.status !== 0) {
  console.error("Not inside a git repository.");
  process.exit(1);
}

const commonDir = run.stdout.trim();

const target = join(
  isAbsolute(commonDir) ? commonDir : join(process.cwd(), commonDir),
  "hooks",
  "pre-commit",
);

if (existsSync(target) && !readFileSync(target, "utf8").includes(MARKER)) {
  console.error(`${target} exists and was not written by this script. Merge it by hand.`);
  process.exit(1);
}

writeFileSync(target, HOOK);

chmodSync(target, 0o755);

console.log(`Installed ${target}.`);
