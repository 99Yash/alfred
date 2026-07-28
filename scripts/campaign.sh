#!/usr/bin/env bash
# Ralph-style loop over a campaign queue: one phase per fresh `claude -p`.
#
# A campaign is a review artifact broken into items (.campaign/<slug>/state.json),
# each walked through design → implement → review ⇄ revise → land. Each phase runs
# in its own process, so context is bounded by construction rather than by asking
# the model to be brief.
#
# Progress is detected the way ralph-react-doctor.sh detects it: by state moving.
# An iteration that leaves (phase, round) unchanged is stuck — the item is parked
# and the loop continues with the next one, rather than spinning on it.
#
# Usage:
#   scripts/campaign.sh                  # work the queue
#   DRY_RUN=1 scripts/campaign.sh        # print prompts, invoke nothing
#   ITEM=07 scripts/campaign.sh          # one item only (how to smoke-test)
#   SLUG=arch-20260727 scripts/campaign.sh
#
# Env:
#   SLUG            campaign slug; inferred when .campaign/ holds exactly one
#   ITEM            restrict to a single item id
#   MAX_ITER        default 20
#   MAX_BUDGET_USD  default 7, PER ITERATION — there is no overall cap, so the
#                   ceiling on a run is MAX_ITER × MAX_BUDGET_USD. A `review`
#                   phase runs three subagent lanes inside one iteration and does
#                   not fit in the default; override it for that phase
#                   (MAX_BUDGET_USD=20) or the round dies mid-synthesis and the
#                   item is parked with only some lanes on disk.
#   DRY_RUN         default 0

set -euo pipefail

MAX_ITER="${MAX_ITER:-20}"
MAX_BUDGET_USD="${MAX_BUDGET_USD:-7}"
DRY_RUN="${DRY_RUN:-0}"
ITEM="${ITEM:-}"

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

PROMPT_TEMPLATE="$REPO_ROOT/scripts/campaign.prompt.txt"
PHASES_DOC="$REPO_ROOT/.claude/skills/campaign/PHASES.md"
REVIEW_DOC="$REPO_ROOT/.claude/skills/campaign/REVIEW.md"
for f in "$PROMPT_TEMPLATE" "$PHASES_DOC" "$REVIEW_DOC"; do
  [[ -f "$f" ]] || { echo "missing $f" >&2; exit 1; }
done

# --- resolve the campaign -------------------------------------------------

if [[ -z "${SLUG:-}" ]]; then
  # bash 3.2 on macOS has no mapfile.
  found=()
  while IFS= read -r d; do found+=("$d"); done < <(
    find "$REPO_ROOT/.campaign" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; 2>/dev/null | sort
  )
  case "${#found[@]}" in
    0) echo "No campaigns in .campaign/. Run /campaign <artifact> to create one." >&2; exit 1 ;;
    1) SLUG="${found[0]}" ;;
    *) echo "Multiple campaigns; pass SLUG=<one of>: ${found[*]}" >&2; exit 1 ;;
  esac
fi

CAMPAIGN_DIR="$REPO_ROOT/.campaign/$SLUG"
STATE="$CAMPAIGN_DIR/state.json"
[[ -f "$STATE" ]] || { echo "missing $STATE" >&2; exit 1; }
jq -e '.items | type == "array"' "$STATE" >/dev/null || { echo "$STATE has no items array" >&2; exit 1; }

BASE_BRANCH="$(jq -r '.baseBranch // "main"' "$STATE")"

# The main checkout must stay clean: items work in their own worktrees, and a dirty
# root means an earlier iteration leaked edits outside its tree.
assert_root_clean() {
  # A dry run invokes nothing and writes nothing, so the tree's state is irrelevant.
  [[ "$DRY_RUN" == "1" ]] && return 0
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "Main checkout is dirty — refusing to continue." >&2
    git status --short >&2
    exit 2
  fi
}

# --- queue selection ------------------------------------------------------

TERMINAL='["landed","needs-human","skipped"]'

# Items to pass over without mutating state: dry-run visits. Real parks go in state.
SKIPPED="$(mktemp -t campaign-skip.XXXXXX)"
trap 'rm -f "$SKIPPED"' EXIT

# Ctrl-C must stop the LOOP, not just the current claude. Without this, SIGINT kills
# the child, `|| true` swallows it, and the loop cheerfully starts the next item —
# so holding Ctrl-C walks the whole queue killing one phase after another.
INTERRUPTED=0
CHILD_PID=""
JQ_PID=""
on_interrupt() {
  INTERRUPTED=1
  echo
  echo "interrupted — stopping. State left as-is."
  # The phase runs as a background job, and a background job in a non-interactive
  # shell has SIGINT *ignored* — so forwarding INT is a no-op and Ctrl-C alone would
  # leave the phase running. TERM, then KILL if it won't go.
  if [[ -n "$CHILD_PID" ]]; then
    kill -TERM "$CHILD_PID" 2>/dev/null
    for _ in $(seq 1 20); do
      kill -0 "$CHILD_PID" 2>/dev/null || break
      sleep 0.5
    done
    kill -KILL "$CHILD_PID" 2>/dev/null
  fi
  # Killing claude does not guarantee its descendants died with it, and any one of
  # them still holding the FIFO keeps the renderer from ever seeing EOF — which
  # would hang the loop on `wait` after we already said we were stopping.
  [[ -n "$JQ_PID" ]] && kill -TERM "$JQ_PID" 2>/dev/null
  return 0
}
trap on_interrupt INT TERM

# Next item: first non-terminal whose prereqs have all landed. Honors $ITEM.
pick_item() {
  local skip_list
  skip_list="$(jq -R -s 'split("\n") | map(select(length > 0))' "$SKIPPED")"
  jq -c --argjson terminal "$TERMINAL" --arg only "$ITEM" --argjson skip "$skip_list" '
    .items as $all
    | [ .items[]
        | select($only == "" or .id == $only)
        | select(.id as $i | $skip | index($i) | not)
        | select(.phase as $p | $terminal | index($p) | not)
        | select(
            [ .prereqs[]? as $r
              | ($all[] | select(.id == $r) | .phase) == "landed" ] | all
          )
      ]
    | .[0] // empty
  ' "$STATE"
}

blocked_report() {
  jq -r --argjson terminal "$TERMINAL" '
    .items as $all
    | [ .items[]
        | select(.phase as $p | $terminal | index($p) | not)
        | select(
            [ .prereqs[]? as $r
              | ($all[] | select(.id == $r) | .phase) == "landed" ] | all | not
          )
        | "  - \(.id) \(.title) — waiting on \(.prereqs | join(", "))"
      ]
    | join("\n")
  ' "$STATE"
}

signature() { # id -> "phase:round", the progress token
  jq -r --arg id "$1" '.items[] | select(.id == $id) | "\(.phase):\(.round // 0)"' "$STATE"
}

park_item() { # id, note
  local tmp; tmp="$(mktemp)"
  jq --arg id "$1" --arg note "$2" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
    .items |= map(if .id == $id then .phase = "needs-human" | .note = $note | .updatedAt = $ts else . end)
  ' "$STATE" > "$tmp" && mv "$tmp" "$STATE"
}

build_prompt() {
  ITEM_ID="$1" ITEM_TITLE="$2" PHASE="$3" ROUND="$4" ITEM_FILE="$5" WORKTREE="$6" \
  SLUG="$SLUG" STATE="$STATE" CAMPAIGN_DIR="$CAMPAIGN_DIR" BASE_BRANCH="$BASE_BRANCH" \
  PHASES_DOC="$PHASES_DOC" REVIEW_DOC="$REVIEW_DOC" \
  perl -0pe '
    for my $k (qw(ITEM_ID ITEM_TITLE PHASE ROUND ITEM_FILE WORKTREE SLUG STATE
                  CAMPAIGN_DIR BASE_BRANCH PHASES_DOC REVIEW_DOC)) {
      my $v = $ENV{$k} // "";
      s/\Q{{$k}}\E/$v/g;
    }
  ' "$PROMPT_TEMPLATE"
}

# --- main loop ------------------------------------------------------------

echo "campaign: $SLUG   base: $BASE_BRANCH   budget: \$$MAX_BUDGET_USD/iter"
[[ -n "$ITEM" ]] && echo "restricted to item $ITEM"

completed=0
for ((i = 1; i <= MAX_ITER; i++)); do
  assert_root_clean

  next="$(pick_item)"
  if [[ -z "$next" ]]; then
    echo
    echo "queue drained."
    blocked="$(blocked_report)"
    [[ -n "$blocked" ]] && { echo "still blocked on prereqs:"; echo "$blocked"; }
    break
  fi

  id="$(jq -r '.id' <<<"$next")"
  title="$(jq -r '.title' <<<"$next")"
  phase="$(jq -r '.phase' <<<"$next")"
  round="$(jq -r '.round // 0' <<<"$next")"
  islug="$(jq -r '.slug' <<<"$next")"
  worktree="$(jq -r '.worktree // ""' <<<"$next")"
  item_file="$CAMPAIGN_DIR/items/$id-$islug.md"

  [[ -f "$item_file" ]] || { echo "missing item file $item_file" >&2; exit 1; }
  [[ -n "$worktree" ]] || worktree="$REPO_ROOT/.claude/worktrees/$SLUG-$id"

  echo
  echo "===== iteration $i/$MAX_ITER · item $id · phase $phase (round $round) ====="
  echo "$title"

  prompt="$(build_prompt "$id" "$title" "$phase" "$round" "$item_file" "$worktree")"

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "--- prompt ---"; printf '%s\n' "$prompt"; echo "--- end prompt ---"
    echo "$id" >> "$SKIPPED"   # advance the loop without touching state
    continue
  fi

  before="$(signature "$id")"
  started_at="$(date +%s)"

  # A phase is mostly tool calls, so printing only assistant *text* looks identical
  # to a hang for minutes at a time. Stream text deltas live, and print one line per
  # tool call so the run is visibly alive.
  # claude runs backgrounded through a FIFO rather than as a foreground pipeline, so
  # the loop holds its real PID: the interrupt trap can forward the signal, and the
  # exit status is claude's own rather than jq's.
  fifo="$(mktemp -u -t campaign-fifo.XXXXXX)"
  mkfifo "$fifo"

  jq -j --unbuffered '
        if .type == "stream_event" then
          ( .event
            | select(.type == "content_block_delta")
            | .delta | select(.type == "text_delta") | .text )
        elif .type == "assistant" then
          ( .message.content[]?
            | select(.type == "tool_use")
            | "\n  · \(.name) \((.input.file_path // .input.command // .input.pattern
                                // .input.description // .input.subagent_type // "")
                               | tostring | .[0:100])\n" )
        elif .type == "result" then
          "\n[\(.subtype) · \(.num_turns // 0) turns · $\((.total_cost_usd // 0) * 100 | round / 100)]\n"
        else empty end
      ' < "$fifo" &
  JQ_PID=$!

  set +e
  printf '%s' "$prompt" | claude -p \
      --permission-mode bypassPermissions \
      --max-budget-usd "$MAX_BUDGET_USD" \
      --no-session-persistence \
      --output-format stream-json \
      --include-partial-messages \
      --verbose > "$fifo" &
  CHILD_PID=$!
  wait "$CHILD_PID"
  claude_status=$?
  CHILD_PID=""   # the trap has already reaped it on the interrupt path
  wait "$JQ_PID" 2>/dev/null
  JQ_PID=""
  set -e
  rm -f "$fifo"

  elapsed=$(( $(date +%s) - started_at ))
  after="$(signature "$id")"

  # 130 = SIGINT, 143 = SIGTERM. An operator kill is not a stuck item.
  if [[ "$INTERRUPTED" == "1" || "$claude_status" == "130" || "$claude_status" == "143" ]]; then
    echo
    echo "item $id interrupted after ${elapsed}s in phase ${before%%:*} — left untouched."
    echo "resume with: scripts/campaign.sh   (or ITEM=$id scripts/campaign.sh)"
    exit 130
  fi

  if [[ "$before" == "$after" ]]; then
    echo "no state movement on item $id ($before) after ${elapsed}s (exit $claude_status) — parking it."
    park_item "$id" "no progress in phase ${before%%:*} (exit $claude_status)"
    continue
  fi

  echo "item $id: $before → $after   (${elapsed}s)"
  [[ "${after%%:*}" == "landed" ]] && completed=$((completed + 1))
done

# --- summary --------------------------------------------------------------

echo
echo "=== done ==="
echo "iterations: $((i - 1))   landed this run: $completed"
jq -r '.items[] | "  \(.id) \(.phase)\(if .pr then " · PR #\(.pr)" else "" end)\(if .note then " · \(.note)" else "" end)  \(.title)"' "$STATE"
echo
echo "open PRs: gh pr list --author @me"
