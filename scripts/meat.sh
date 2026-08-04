#!/usr/bin/env bash
#
# meat — abridge a git diff into a "reading diff".
#
# A local, no-API-key reproduction of https://github.com/boldsoftware/meat.
# It pipes a git diff plus meat's reading rubric into `claude -p` (headless
# Claude Code), so it runs on your Claude Code subscription. No ANTHROPIC_API_KEY,
# no Go toolchain, no install.
#
# NOTE: This is meat's *reading value*, not meat's machinery. It does not run
# meat's structured edit-plan compiler, exact cross-file move detection, or
# import-elision passes. It asks the model to keep concepts and drop noise.
#
# Usage:
#   scripts/meat.sh                 # the latest commit (git show HEAD)
#   scripts/meat.sh <rev>           # a single commit (git show <rev>)
#   scripts/meat.sh <a>..<b>        # a commit range (git diff a..b)
#   scripts/meat.sh --staged        # staged changes (git diff --cached)
#   scripts/meat.sh --worktree      # unstaged working-tree changes (git diff)
#
set -euo pipefail

RUBRIC='You are a code-reading assistant for a senior engineer who reads diffs of GOOD code all day. The code compiles and its tests pass. The reviewer is NOT hunting for nil panics or style. They want to understand the change at a high level: what changed, where data came from, where it went, what new control flow or behavior appeared.

You are given a unified git diff (it may span many files). Produce an abridged "reading diff" that a person reads in one screen. Rules:
- KEEP the load-bearing changes: new/changed control flow, data movement, behavior, algorithm and architecture choices, and any moved code (show a moved block once and say it moved from X to Y).
- REMOVE pure noise: import reordering, nil-checks, formatting, and mechanical repetition. Collapse a long verbose run to a single "..." with a short note of what it was.
- Reason across files: a line that looks like noise in one file is often explained by a change in another.
- Show real code fragments from the diff (keep +/- markers) for the parts you keep. Do NOT invent identifiers, comments, or behavior. This is for READING, not compiling.
- End with a one-line summary of the whole change.
Keep the output tight. Favor the meat.'

diff_for_args() {
  if [[ $# -eq 0 ]]; then
    git show HEAD
    return
  fi
  case "$1" in
    --staged|--cached) git diff --cached ;;
    --worktree)        git diff ;;
    *..*)              git diff "$@" ;;
    *)                 git show "$@" ;;
  esac
}

DIFF="$(diff_for_args "$@")"

if [[ -z "${DIFF//[[:space:]]/}" ]]; then
  echo "meat: empty diff for '${*:-HEAD}' — nothing to read." >&2
  exit 0
fi

printf '%s' "$DIFF" | claude -p "$RUBRIC"
