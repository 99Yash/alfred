#!/usr/bin/env bash
# Ralph-style loop: fix react-doctor violations one rule family per iteration.
# Each iteration spawns a fresh `claude -p` that fixes one rule, runs
# pnpm check-types, and commits. The driver then pushes that commit so the
# `reactreview[bot]` on the PR sees the new state. The script loops until
# zero warnings, the iteration cap is hit, or a rule gets stuck (no new
# commit) or a push fails.
#
# Usage:
#   scripts/ralph-react-doctor.sh             # run the loop
#   DRY_RUN=1 scripts/ralph-react-doctor.sh   # print prompts, don't invoke claude
#   MAX_ITER=5 scripts/ralph-react-doctor.sh  # cap iterations
#
# Env:
#   MAX_ITER          default 30
#   MAX_BUDGET_USD    default 3 (per iteration)
#   SEVERITY_FILTER   default "warning,error" (jq regex over .severity)

set -euo pipefail

MAX_ITER="${MAX_ITER:-30}"
MAX_BUDGET_USD="${MAX_BUDGET_USD:-3}"
SEVERITY_FILTER="${SEVERITY_FILTER:-warning|error}"
DRY_RUN="${DRY_RUN:-0}"

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

PROMPT_TEMPLATE="$REPO_ROOT/scripts/ralph-react-doctor.prompt.txt"
[[ -f "$PROMPT_TEMPLATE" ]] || { echo "missing $PROMPT_TEMPLATE" >&2; exit 1; }

branch="$(git rev-parse --abbrev-ref HEAD)"
[[ "$branch" == "main" || "$branch" == "master" ]] && {
  echo "Refusing to run on $branch." >&2; exit 1;
}

# Refuse dirty tree — we rely on git HEAD movement to detect progress.
if ! git diff --quiet || ! git diff --cached --quiet \
   || [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
  echo "Working tree has uncommitted or untracked changes." >&2
  echo "Commit or stash before running this loop." >&2
  git status --short >&2
  exit 1
fi

JSON="$(mktemp -t ralph-rd.XXXXXX.json)"
SKIPPED="$(mktemp -t ralph-rd-skipped.XXXXXX)"
trap 'rm -f "$JSON" "$SKIPPED"' EXIT

# --- helpers --------------------------------------------------------------

run_react_doctor() {
  ( cd apps/web && npx -y react-doctor@latest --json --verbose --diff ) > "$JSON" 2>/dev/null || true
  jq -e 'type == "object" and has("diagnostics")' "$JSON" >/dev/null \
    || { echo "react-doctor returned no JSON" >&2; return 1; }
}

count_remaining() {
  jq --arg sev "$SEVERITY_FILTER" \
     '[.diagnostics[] | select(.severity | test($sev))] | length' "$JSON"
}

pick_top_rule() {
  # Pick the rule with the most occurrences that isn't in $SKIPPED.
  local skip_list
  skip_list="$(jq -R -s 'split("\n") | map(select(length > 0))' "$SKIPPED")"
  jq -r --arg sev "$SEVERITY_FILTER" --argjson skip "$skip_list" '
    [.diagnostics[] | select(.severity | test($sev)) | select(.rule as $r | $skip | index($r) | not)]
    | group_by(.rule)
    | map({rule: .[0].rule, count: length, sample: .[0]})
    | sort_by(-.count)
    | .[0] // empty
  ' "$JSON"
}

build_prompt() {
  local rule="$1" count="$2" category="$3" message="$4" help="$5"
  local violations
  violations="$(jq -r --arg r "$rule" '
    .diagnostics[]
    | select(.rule == $r)
    | "- \(.filePath):\(.line)  [\(.severity)]  \(.message)"
  ' "$JSON")"

  # perl handles multiline env vars cleanly; awk -v does not.
  RULE="$rule" COUNT="$count" CATEGORY="$category" \
  MESSAGE="$message" HELP="$help" VIOLATIONS="$violations" \
  perl -0pe '
    s/\Q{{RULE}}\E/$ENV{RULE}/g;
    s/\Q{{COUNT}}\E/$ENV{COUNT}/g;
    s/\Q{{CATEGORY}}\E/$ENV{CATEGORY}/g;
    s/\Q{{MESSAGE}}\E/$ENV{MESSAGE}/g;
    s/\Q{{HELP}}\E/$ENV{HELP}/g;
    s/\Q{{VIOLATIONS}}\E/$ENV{VIOLATIONS}/g;
  ' "$PROMPT_TEMPLATE"
}

# --- main loop ------------------------------------------------------------

start_head="$(git rev-parse HEAD)"

for ((i=1; i<=MAX_ITER; i++)); do
  echo
  echo "===== iteration $i / $MAX_ITER ====="

  run_react_doctor || break

  remaining="$(count_remaining)"
  echo "remaining diagnostics: $remaining"
  if [[ "$remaining" -eq 0 ]]; then
    echo "all clear."
    break
  fi

  top="$(pick_top_rule)"
  if [[ -z "$top" ]]; then
    echo "no more rules to attempt (all remaining are in skip-list)."
    break
  fi

  rule="$(jq -r '.rule' <<<"$top")"
  count="$(jq -r '.count' <<<"$top")"
  category="$(jq -r '.sample.category // "-"' <<<"$top")"
  message="$(jq -r '.sample.message' <<<"$top")"
  help="$(jq -r '.sample.help // "-"' <<<"$top")"

  echo "rule: $rule  ($count occurrences, category: $category)"

  prompt="$(build_prompt "$rule" "$count" "$category" "$message" "$help")"

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "--- prompt ---"
    printf '%s\n' "$prompt"
    echo "--- end prompt ---"
    # In dry-run, mark this rule as skipped so the loop progresses to the next.
    echo "$rule" >> "$SKIPPED"
    continue
  fi

  pre_head="$(git rev-parse HEAD)"

  # Spawn fresh claude. bypassPermissions so it can run pnpm + git without prompts.
  printf '%s' "$prompt" | claude -p \
      --permission-mode bypassPermissions \
      --max-budget-usd "$MAX_BUDGET_USD" \
      --no-session-persistence \
      --output-format stream-json \
      --include-partial-messages \
      --verbose \
    | jq -r --unbuffered '
        select(.type == "assistant")
        | .message.content[]?
        | select(.type == "text")
        | .text
      ' || true

  post_head="$(git rev-parse HEAD)"

  if [[ "$pre_head" == "$post_head" ]]; then
    echo "no commit landed for $rule — marking as stuck, resetting any dangling edits."
    git reset --hard "$pre_head"
    git clean -fd -- apps/web/src
    echo "$rule" >> "$SKIPPED"
    continue
  fi

  echo "commit: $(git log -1 --format='%h %s')"

  # Defensive: if anything is still uncommitted, refuse to continue.
  if ! git diff --quiet || ! git diff --cached --quiet \
     || [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
    echo "tree dirty after iteration — stopping to avoid silent drift." >&2
    git status --short >&2
    exit 2
  fi

  echo "pushing..."
  if ! git push; then
    echo "git push failed — stopping so you can resolve before the next iteration." >&2
    exit 3
  fi
done

end_head="$(git rev-parse HEAD)"
commits="$(git rev-list --count "$start_head..$end_head")"

echo
echo "=== done ==="
echo "iterations: $i"
echo "commits added: $commits ($start_head..$end_head)"
if [[ -s "$SKIPPED" ]]; then
  echo "skipped/stuck rules:"
  sort -u "$SKIPPED" | sed 's/^/  - /'
fi
echo "review with: git log $start_head..HEAD --oneline"
