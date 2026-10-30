#!/usr/bin/env node
/**
 * Drives `.claude/hooks/merge-guard.mjs` against the merge it exists to stop: a merge
 * that skips red required checks (`gh pr merge --admin`, or the REST or GraphQL merge).
 *
 * Two halves. The fixture table calls `findBypass` for each Bash input and states the
 * decision. Each `allow` row is a near miss that quotes the flag as text, so a guard that
 * only greps for `--admin` goes red here. The process rows pipe real PreToolUse JSON into
 * the hook and read its stdout, so the stdin and deny contract is under test too.
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { findBypass } from "../.claude/hooks/merge-guard.mjs";

const HOOK = join(import.meta.dirname, "..", ".claude", "hooks", "merge-guard.mjs");

/** @type {["allow" | "deny", string][]} */
const FIXTURES = [
  ["allow", "gh pr merge 1600 --squash --delete-branch"],
  ["allow", "gh pr view 1600 --json state"],
  ["allow", "node scripts/wait-pr-checks.mjs 1600"],
  ["allow", `git commit -m "chore: deny gh pr merge --admin in a hook"`],
  ["allow", `gh pr create --title "Deny --admin merges" --body "Blocks gh pr merge 12 --admin."`],
  ["allow", `gh pr merge 12 --squash --body "Never use --admin here."`],
  ["allow", "git commit -F - <<'EOF'\nDeny gh pr merge 12 --admin.\nEOF\ngit push"],
  ["allow", "echo 'gh pr merge 12 --admin' # a quoted example"],
  ["allow", "gh pr merge 12 --admin=false"],
  ["allow", "gh api repos/99Yash/alfred/pulls/12/merge"],
  ["allow", "gh api graphql -f query='query { viewer { login } }'"],
  ["allow", "rg -n -- '--admin' docs"],
  ["deny", "gh pr merge 1600 --admin"],
  ["deny", "gh pr merge 1600 --squash --admin --delete-branch"],
  ["deny", "gh pr merge --admin=true 1600"],
  ["deny", "cd /tmp && gh pr merge 12 --admin"],
  ["deny", "node scripts/wait-pr-checks.mjs 12; gh pr merge 12 --admin"],
  ["deny", "GH_TOKEN=x gh pr merge 12 --admin"],
  ["deny", "env GH_REPO=99Yash/alfred /opt/homebrew/bin/gh pr merge 12 --admin"],
  ["deny", `bash -c "gh pr merge 12 --admin"`],
  ["deny", `zsh -lc 'gh pr merge 12 --squash --admin'`],
  ["deny", `eval "gh pr merge 12 --admin"`],
  ["deny", `echo "$(gh pr merge 12 --admin)"`],
  ["deny", "echo `gh pr merge 12 --admin`"],
  ["deny", "gh pr merge 12 \\\n  --squash \\\n  --admin"],
  ["deny", `gh pr merge 12 "--admin"`],
  ["deny", "gh api -X PUT repos/99Yash/alfred/pulls/12/merge -f merge_method=squash"],
  ["deny", "gh api --method=put /repos/99Yash/alfred/pulls/12/merge"],
  ["deny", "gh api -XPUT repos/99Yash/alfred/pulls/12/merge"],
  [
    "deny",
    `gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }'`,
  ],
];

/** Raw stdin for the hook process, and whether it must print a deny. */
const PROCESS_CASES = [
  {
    label: "plain merge",
    stdin: JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "gh pr merge 12 --squash" },
    }),
    deny: false,
  },
  {
    label: "admin merge",
    stdin: JSON.stringify({ tool_name: "Bash", tool_input: { command: "gh pr merge 12 --admin" } }),
    deny: true,
  },
  {
    label: "admin flag inside a commit message",
    stdin: JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: `git commit -m "deny gh pr merge --admin"` },
    }),
    deny: false,
  },
  {
    label: "other tool",
    stdin: JSON.stringify({ tool_name: "Edit", tool_input: { command: "gh pr merge 12 --admin" } }),
    deny: false,
  },
  { label: "input that is not JSON", stdin: "not json", deny: false },
];

const failures = [];

for (const [want, command] of FIXTURES) {
  const got = findBypass(command) ? "deny" : "allow";

  if (got !== want) failures.push(`want ${want}, got ${got}: ${JSON.stringify(command)}`);
}

for (const { label, stdin, deny } of PROCESS_CASES) {
  const stdout = execFileSync(process.execPath, [HOOK], { input: stdin, encoding: "utf8" });

  if (!deny) {
    if (stdout !== "") failures.push(`${label}: want no output, got ${JSON.stringify(stdout)}`);
    continue;
  }

  let decision = "";

  try {
    const parsed = JSON.parse(stdout);

    decision = `${parsed.hookSpecificOutput?.hookEventName}/${parsed.hookSpecificOutput?.permissionDecision}`;
  } catch {
    decision = `unparsed ${JSON.stringify(stdout)}`;
  }

  if (decision !== "PreToolUse/deny")
    failures.push(`${label}: want PreToolUse/deny, got ${decision}`);
}

if (failures.length > 0) {
  process.stderr.write(
    `merge-guard selftest: ${failures.length} failure(s)\n${failures.join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `merge-guard selftest: ${FIXTURES.length} fixtures and ${PROCESS_CASES.length} hook runs pass\n`,
);
