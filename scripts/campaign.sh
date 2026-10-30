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
#   MAX_BUDGET_USD  default 8, PER ITERATION, for every phase EXCEPT review.
#                   There is no overall cap, so the ceiling on a run is
#                   MAX_ITER × the largest per-phase budget. Measured phase costs:
#                   design ~$2.9, implement ~$4.1, revise ~$2.5. 8 leaves roughly
#                   2x headroom over the most expensive write phase.
#   REVIEW_BUDGET_USD
#                   default 12, and it is NOT bounded by MAX_BUDGET_USD — a review
#                   phase fans out to three subagent lanes and then synthesizes
#                   them inside ONE iteration, measured at $6.6–9.0. Anything under
#                   ~$10 kills it *after* the lanes write and *during* synthesis:
#                   the reports are on disk and salvageable, but the item parks
#                   with no verdict. Lower this only to park a review deliberately.
#   MIN_PHASE_SECONDS
#                   default 15. Below this, a non-progressing phase is treated as
#                   never having run rather than as stuck. See the guard below.
#   STALE_OUTPUT_SECONDS
#                   default 1200. When a phase writes no stream line for this long,
#                   the watchdog kills it and the run stops WITHOUT parking the
#                   item. An expired auth session once killed the review subagents
#                   with no log line, and the phases then waited with flat CPU. A
#                   review phase polls for its reports in Bash calls of less than
#                   10 min (REVIEW.md), so a healthy wait writes a line in time.
#                   0 turns the watchdog off.
#   DRY_RUN         default 0
#   ENGINE          which CLI runs a phase: `claude` (default) or `opencode`.
#                   This is the FALLBACK; a per-phase override wins.
#                   `opencode` is NOT equivalent, and three differences matter:
#                     1. It has no `--max-budget-usd`. MAX_BUDGET_USD and
#                        REVIEW_BUDGET_USD are IGNORED, so MAX_ITER is the only
#                        ceiling on a run. Use a free model, or watch it.
#                     2. It loads AGENTS.md (a symlink to CLAUDE.md here), so the
#                        repo directives carry over — but NOT `.claude/skills/`,
#                        `.claude/hooks/` or `.claude/agents/`. The helper-hint and
#                        recall hooks do not fire.
#                     3. REVIEW.md fans a review round out to three parallel
#                        subagents. That is a Claude Code construct. Under opencode
#                        the model runs the three lanes itself, in one context,
#                        which is what REVIEW.md's cost note says to avoid.
#   DESIGN_ENGINE   per-phase CLI overrides. Each defaults to $ENGINE, so setting
#   IMPLEMENT_ENGINE  only one of them is the common case and setting none keeps
#   REVIEW_ENGINE     the single-engine behavior this script always had. The
#   REVISE_ENGINE     split that earns its keep is REVIEW on `claude` and the two
#                     write phases on `opencode`: REVIEW.md's three-lane fan-out is
#                     only real under `claude` (difference 3 above), and the write
#                     phases are mechanical edits against a design already on the
#                     record, which is what a cheap model is for. Routing a
#                     REVIEW phase to `opencode` is allowed and gives up the
#                     fan-out — the header says so rather than the operator
#                     discovering it three rounds in.
#   MODEL           model for an opencode phase, as `provider/model`. Default
#                   `opencode/muse-spark-1.3-contributor-free`. Ignored by `claude`.
#                   `DESIGN_MODEL` / `IMPLEMENT_MODEL` / `REVIEW_MODEL` /
#                   `REVISE_MODEL` override it per phase, for the same reason the
#                   engines are per-phase: the review fan-out and the mechanical
#                   edit want different models, and one global cannot be both.

set -euo pipefail

MAX_ITER="${MAX_ITER:-20}"
MAX_BUDGET_USD="${MAX_BUDGET_USD:-8}"
REVIEW_BUDGET_USD="${REVIEW_BUDGET_USD:-12}"
MIN_PHASE_SECONDS="${MIN_PHASE_SECONDS:-15}"
STALE_OUTPUT_SECONDS="${STALE_OUTPUT_SECONDS:-1200}"
DRY_RUN="${DRY_RUN:-0}"
ITEM="${ITEM:-}"
ENGINE="${ENGINE:-claude}"
MODEL="${MODEL:-opencode/muse-spark-1.3-contributor-free}"

# Phase name (upper-cased) -> the override var that names it, so the resolution
# below is a table lookup rather than four hand-copied blocks that can drift.
phase_override() { # phase, "VAR_PREFIX" (ENGINE|MODEL) -> value or empty
  # An explicit `case`, not `${!name}`. Two bash 3.2 traps live in the indirect
  # forms and both fail SILENTLY, returning empty so every override is ignored
  # and the run looks configured while using the default engine:
  #   - `local var=X; echo "${!var}"` does not resolve, because 3.2 will not
  #     indirect-expand a name `local` created in the same function.
  #   - `eval` with the name assembled from a positional parameter needs quoting
  #     that is easy to get wrong and equally quiet when it is.
  # The phase set is closed and short, so naming it outright costs six lines and
  # is the only version whose failure mode is a syntax error, not a wrong run.
  # `<KIND>_<PHASE>`, matching the names in the header: DESIGN_ENGINE, not
  # ENGINE_DESIGN. The `$2` argument is the KIND.
  case "$1" in
    cover)     [ "$2" = ENGINE ] && printf '%s' "${COVER_ENGINE-}" ;;
    design)    [ "$2" = ENGINE ] && printf '%s' "${DESIGN_ENGINE-}" ;;
    implement) [ "$2" = ENGINE ] && printf '%s' "${IMPLEMENT_ENGINE-}" ;;
    review)    [ "$2" = ENGINE ] && printf '%s' "${REVIEW_ENGINE-}" ;;
    revise)    [ "$2" = ENGINE ] && printf '%s' "${REVISE_ENGINE-}" ;;
    land)      [ "$2" = ENGINE ] && printf '%s' "${LAND_ENGINE-}" ;;
  esac
  case "$1" in
    cover)     [ "$2" = MODEL ] && printf '%s' "${COVER_MODEL-}" ;;
    design)    [ "$2" = MODEL ] && printf '%s' "${DESIGN_MODEL-}" ;;
    implement) [ "$2" = MODEL ] && printf '%s' "${IMPLEMENT_MODEL-}" ;;
    review)    [ "$2" = MODEL ] && printf '%s' "${REVIEW_MODEL-}" ;;
    revise)    [ "$2" = MODEL ] && printf '%s' "${REVISE_MODEL-}" ;;
    land)      [ "$2" = MODEL ] && printf '%s' "${LAND_MODEL-}" ;;
  esac
  return 0
}

# Resolve, validate, and announce the CLI for one phase. Called per iteration
# rather than once at startup, because a campaign can route different phases to
# different engines and only the phase in hand decides which binary must exist.
# Validating the override here is what turns a typo into one clear line naming
# the variable, instead of a `case` fallthrough at run time.
resolve_engine() { # phase -> sets RESOLVED_ENGINE / RESOLVED_MODEL, echoes label
  local phase="$1" override
  override="$(phase_override "$phase" ENGINE)"
  RESOLVED_ENGINE="${override:-$ENGINE}"
  case "$RESOLVED_ENGINE" in
    claude|opencode) ;;
    *)
      echo "unknown engine '$RESOLVED_ENGINE' for phase '$phase'" \
        "(from $(printf '%s' "$phase" | tr '[:lower:]' '[:upper:]')_ENGINE / ENGINE)" \
        "— expected claude or opencode" >&2
      exit 1
      ;;
  esac
  command -v "$RESOLVED_ENGINE" >/dev/null || {
    echo "$RESOLVED_ENGINE is not on PATH (required for phase '$phase')" >&2
    exit 1
  }
  RESOLVED_MODEL="$(phase_override "$phase" MODEL)"
  RESOLVED_MODEL="${RESOLVED_MODEL:-$MODEL}"
  RESOLVED_LABEL=""
  # An `if`, not a trailing `[[ ]] &&`. As the function's last statement that
  # list makes the function return 1 for a `claude` phase, and `set -e` kills the
  # whole run on a return value that means nothing.
  if [[ "$RESOLVED_ENGINE" == "opencode" ]]; then
    RESOLVED_LABEL=" ($RESOLVED_MODEL, no budget cap)"
  fi
}

command -v "$ENGINE" >/dev/null || { echo "$ENGINE is not on PATH" >&2; exit 1; }

# An override naming a binary that is not installed is a routing typo, and it is
# worth catching before the loop rather than on the iteration that reaches it —
# otherwise a design phase runs for real and the implement phase is the first to
# discover the typo. `resolve_engine` re-checks per phase, so this is a fast
# fail, not the only check.
for _p in cover design implement review revise land; do
  _e="$(phase_override "$_p" ENGINE)"
  [[ -n "$_e" ]] || continue
  command -v "$_e" >/dev/null || {
    echo "$(printf '%s' "$_p" | tr '[:lower:]' '[:upper:]')_ENGINE=$_e is not on PATH" >&2
    exit 1
  }
done

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

# One lane file per running driver, so `scripts/campaign-ops.mjs status` can list the
# live lanes and how long each has been quiet. The heartbeat file's mtime is the time
# of the last stream line; the watchdog below reads the same file.
LANE_DIR="$CAMPAIGN_DIR/lanes"
LANE_FILE="$LANE_DIR/$$.json"
HEARTBEAT="$LANE_DIR/$$.heartbeat"
RESULT_LINE="$LANE_DIR/$$.result"
STALE_MARK="$LANE_DIR/$$.stale"

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
trap 'rm -f "$SKIPPED" "$LANE_FILE" "$HEARTBEAT" "$RESULT_LINE" "$STALE_MARK"' EXIT

# Ctrl-C must stop the LOOP, not just the current claude. Without this, SIGINT kills
# the child, `|| true` swallows it, and the loop cheerfully starts the next item —
# so holding Ctrl-C walks the whole queue killing one phase after another.
INTERRUPTED=0
CHILD_PID=""
JQ_PID=""
TAP_PID=""
WATCHDOG_PID=""
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
  [[ -n "$WATCHDOG_PID" ]] && kill -TERM "$WATCHDOG_PID" 2>/dev/null
  [[ -n "$TAP_PID" ]] && kill -TERM "$TAP_PID" 2>/dev/null
  [[ -n "$JQ_PID" ]] && kill -TERM "$JQ_PID" 2>/dev/null
  return 0
}
trap on_interrupt INT TERM

# Both selection filters below open with the same guard clause, byte for byte.
#
# `.prereqs[]?` reads a NON-ARRAY `prereqs` as no prerequisites at all: iterating a string is
# a jq error and the `?` swallows it. So an item sequenced behind work that has not landed is
# offered as unblocked, and the blocked report never mentions it. That is a fail-open, and the
# thing it lets through is a lane started on work the operator sequenced away.
#
# The guard runs BEFORE the `$only` filter on purpose: a malformed item must be reported even
# when `ITEM=` restricts the run to a different one. `set -euo pipefail` plus the command
# substitution at both call sites turns jq's exit 5 into a stopped loop, which is the point —
# one corrupt item halts the campaign until a human repairs it. A missing or null `prereqs`
# is NOT malformed; it already reads as the empty list, which is what it means.
# Next item: first non-terminal whose prereqs have all landed. Honors $ITEM.
pick_item() {
  local skip_list
  skip_list="$(jq -R -s 'split("\n") | map(select(length > 0))' "$SKIPPED")"
  jq -c --argjson terminal "$TERMINAL" --arg only "$ITEM" --argjson skip "$skip_list" '
    [ .items[] | select(.prereqs != null and (.prereqs | type) != "array") | .id ] as $malformed
    | if ($malformed | length) > 0
      then error("item(s) \($malformed | join(", ")) carry a non-array prereqs — repair with: scripts/campaign-state.mjs set --state <state.json> --id <id> prereqs=<a,b>")
      else . end
    | .items as $all
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
    [ .items[] | select(.prereqs != null and (.prereqs | type) != "array") | .id ] as $malformed
    | if ($malformed | length) > 0
      then error("item(s) \($malformed | join(", ")) carry a non-array prereqs — repair with: scripts/campaign-state.mjs set --state <state.json> --id <id> prereqs=<a,b>")
      else . end
    | .items as $all
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

write_lane() { # id, phase, round
  jq -n --argjson pid "$$" --arg item "$1" --arg phase "$2" --arg round "$3" \
    --arg engine "$RESOLVED_ENGINE" --arg heartbeat "$HEARTBEAT" \
    --arg startedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{pid: $pid, item: $item, phase: $phase, round: $round, engine: $engine,
      startedAt: $startedAt, heartbeat: $heartbeat}' > "$LANE_FILE.tmp"
  mv "$LANE_FILE.tmp" "$LANE_FILE"
}

# Kills the phase when the heartbeat has not moved for STALE_OUTPUT_SECONDS. It runs
# as its own background subshell and leaves a mark file, so the main loop can tell a
# watchdog kill from an operator kill: both end the child with SIGTERM.
start_watchdog() { # child pid
  WATCHDOG_PID=""
  [[ "$STALE_OUTPUT_SECONDS" -gt 0 ]] || return 0
  (
    # A failed `pkill` (no child matched) must not end the watchdog before the kill.
    set +e
    while kill -0 "$1" 2>/dev/null; do
      sleep 15
      quiet="$(perl -e 'print time - (stat shift)[9]' "$HEARTBEAT" 2>/dev/null)"
      if [[ -n "$quiet" && "$quiet" -ge "$STALE_OUTPUT_SECONDS" ]]; then
        printf '%s\n' "$quiet" > "$STALE_MARK"
        pkill -TERM -P "$1" 2>/dev/null
        kill -TERM "$1" 2>/dev/null
        sleep 10
        pkill -KILL -P "$1" 2>/dev/null
        kill -KILL "$1" 2>/dev/null
        exit 0
      fi
    done
  ) &
  WATCHDOG_PID=$!
}

# Prints the first limit or auth phrase in the phase's last `result` event, or
# nothing. Only an error result, or a result of one turn, is read: a normal final
# message can mention a rate limit when the item is about one.
limit_reason() {
  [[ -s "$RESULT_LINE" ]] || return 0
  jq -r 'select(.is_error == true or ((.num_turns // 0) <= 1)) | (.result // "") | tostring' \
      "$RESULT_LINE" 2>/dev/null \
    | grep -i -o -m1 -E 'usage limit|hit your limit|limit reached|rate limit|oauth token|token (has )?expired|invalid api key|/login|authentication|unauthorized' \
    || true
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

echo "campaign: $SLUG   base: $BASE_BRANCH   budget: \$$MAX_BUDGET_USD/iter, \$$REVIEW_BUDGET_USD for review"

# The routing, printed as a table rather than a single engine name. A run whose
# review and implement phases are on different CLIs is the case worth seeing at a
# glance, and printing only $ENGINE would hide exactly the thing an operator
# needs to confirm before spending the run.
routing_rows=()
for _p in cover design implement review revise land; do
  resolve_engine "$_p"
  # 10 wide, not 9: `implement` is exactly 9 characters, so %-9s runs the engine
  # straight into the longest phase name and the column stops being a column.
  routing_rows+=("  $(printf '%-10s' "$_p")$RESOLVED_ENGINE$RESOLVED_LABEL")
done
printf 'engine routing:\n%s\n' "$(printf '%s\n' "${routing_rows[@]}")"

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

  # A review phase pays for three subagent lanes plus synthesis in one iteration;
  # every other phase is a single lane. One budget for both starves one or overpays
  # the other, so the phase picks.
  case "$phase" in
    review) iter_budget="$REVIEW_BUDGET_USD" ;;
    *)      iter_budget="$MAX_BUDGET_USD" ;;
  esac

  # Which CLI runs THIS phase, not the run. Resolved before the prompt is built
  # so the iteration banner names the engine that will actually execute.
  resolve_engine "$phase"

  # An opencode phase ignores iter_budget — it has no --max-budget-usd — so
  # advertising the number next to it would be a claim the run cannot honor.
  if [[ "$RESOLVED_ENGINE" == "opencode" ]]; then
    budget_label="no budget cap"
  else
    budget_label="\$$iter_budget"
  fi

  echo
  echo "===== iteration $i/$MAX_ITER · item $id · phase $phase (round $round) · $RESOLVED_ENGINE$RESOLVED_LABEL · $budget_label ====="
  echo "$title"

  prompt="$(build_prompt "$id" "$title" "$phase" "$round" "$item_file" "$worktree")"

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "--- prompt ---"; printf '%s\n' "$prompt"; echo "--- end prompt ---"
    echo "$id" >> "$SKIPPED"   # advance the loop without touching state
    continue
  fi

  before="$(signature "$id")"
  started_at="$(date +%s)"

  mkdir -p "$LANE_DIR"
  : > "$HEARTBEAT"
  rm -f "$RESULT_LINE" "$STALE_MARK"
  write_lane "$id" "$phase" "$round"

  # A phase is mostly tool calls, so printing only assistant *text* looks identical
  # to a hang for minutes at a time. Stream text deltas live, and print one line per
  # tool call so the run is visibly alive.
  # claude runs backgrounded through a FIFO rather than as a foreground pipeline, so
  # the loop holds its real PID: the interrupt trap can forward the signal, and the
  # exit status is claude's own rather than jq's.
  fifo="$(mktemp -u -t campaign-fifo.XXXXXX)"
  render_fifo="$(mktemp -u -t campaign-render.XXXXXX)"
  mkfifo "$fifo" "$render_fifo"

  # The tap sits between the engine and the renderer. It moves the heartbeat at most
  # every 5 s, keeps the last `result` event for `limit_reason`, and passes each line
  # on unchanged. It is its own job, not a pipe into jq, so the trap can kill it.
  HB="$HEARTBEAT" RESULT="$RESULT_LINE" perl -ne '
    BEGIN { $| = 1 }
    if (time - $t >= 5) { utime undef, undef, $ENV{HB}; $t = time }
    if (/"type":"result"/) { open my $o, ">", $ENV{RESULT}; print $o $_; close $o }
    print;
  ' < "$fifo" > "$render_fifo" &
  TAP_PID=$!

  # Two engines, two event schemas. `claude` streams `stream_event`/`assistant`/
  # `result`; `opencode --format json` streams `text`/`tool_use`/`step_finish` with
  # the payload under `.part`. One filter reads both so the console looks the same.
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
        elif .type == "text" then
          ( .part.text // "" )
        elif .type == "tool_use" then
          ( .part
            | "\n  · \(.tool // "tool") \((.state.input.path // .state.input.filePath
                                          // .state.input.file_path // .state.input.command
                                          // .state.input.pattern // .state.input.query
                                          // .state.input.description // "")
                                         | tostring | .[0:100])\n" )
        else empty end
      ' < "$render_fifo" &
  JQ_PID=$!

  set +e
  case "$RESOLVED_ENGINE" in
    claude)
      printf '%s' "$prompt" | claude -p \
          --permission-mode bypassPermissions \
          --max-budget-usd "$iter_budget" \
          --no-session-persistence \
          --output-format stream-json \
          --include-partial-messages \
          --verbose > "$fifo" &
      ;;
    opencode)
      # No budget flag exists, so $iter_budget is deliberately unused here. The
      # header documents that MAX_ITER is the only ceiling under this engine.
      printf '%s' "$prompt" | opencode run \
          --model "$RESOLVED_MODEL" \
          --auto \
          --format json > "$fifo" &
      ;;
  esac
  CHILD_PID=$!
  start_watchdog "$CHILD_PID"
  wait "$CHILD_PID"
  claude_status=$?
  CHILD_PID=""   # the trap has already reaped it on the interrupt path
  if [[ -n "$WATCHDOG_PID" ]]; then
    kill -TERM "$WATCHDOG_PID" 2>/dev/null
    wait "$WATCHDOG_PID" 2>/dev/null
    WATCHDOG_PID=""
  fi
  # After a watchdog kill, a descendant can still hold the FIFO open, and the tap
  # would then wait for an EOF that never comes. The same reason as on_interrupt.
  if [[ -s "$STALE_MARK" ]]; then
    kill -TERM "$TAP_PID" "$JQ_PID" 2>/dev/null
  fi
  wait "$TAP_PID" 2>/dev/null
  wait "$JQ_PID" 2>/dev/null
  TAP_PID=""
  JQ_PID=""
  set -e
  rm -f "$fifo" "$render_fifo"

  elapsed=$(( $(date +%s) - started_at ))
  after="$(signature "$id")"

  # Checked before the interrupt branch, because the watchdog also kills with SIGTERM.
  if [[ -s "$STALE_MARK" ]]; then
    echo
    echo "item $id wrote no stream output for $(cat "$STALE_MARK")s in phase ${before%%:*} — the watchdog killed it."
    echo "Most likely an expired auth session or a hung call. State left untouched, and the run is stopping."
    echo "Check 'claude -p' auth, then resume with: ITEM=$id scripts/campaign.sh"
    exit 4
  fi

  # 130 = SIGINT, 143 = SIGTERM. An operator kill is not a stuck item.
  if [[ "$INTERRUPTED" == "1" || "$claude_status" == "130" || "$claude_status" == "143" ]]; then
    echo
    echo "item $id interrupted after ${elapsed}s in phase ${before%%:*} — left untouched."
    echo "resume with: scripts/campaign.sh   (or ITEM=$id scripts/campaign.sh)"
    exit 130
  fi

  # A phase that dies in seconds never ran — a usage limit, an auth failure, or a
  # prompt that would not render. `claude -p` reports a usage limit as a *`success`*
  # result with 1 turn and $0.00, so exit status alone cannot tell it from a phase
  # that genuinely made no progress. The clock can.
  #
  # Parking on it is actively destructive, and not hypothetically: a limit hits every
  # subsequent iteration too, so ONE hard stop walks the rest of the queue marking
  # items `needs-human` that never executed. That is exactly what happened on
  # 2026-07-28 — five items parked in 13 seconds, each note overwritten with "no
  # progress in phase design", which is also how their real notes were lost. Stop the
  # run instead and leave state alone.
  if [[ "$before" == "$after" && "$elapsed" -lt "$MIN_PHASE_SECONDS" ]]; then
    echo
    echo "item $id exited after only ${elapsed}s (exit $claude_status) — the phase never ran."
    echo "Most likely a usage limit; also possible: auth, or a prompt-render failure."
    echo "State left untouched, and the run is stopping so the queue is not parked behind it."
    echo "Resume with: scripts/campaign.sh   (or ITEM=$id scripts/campaign.sh)"
    exit 3
  fi

  # A usage limit or an expired session that hits a LONG phase passes the clock
  # guard above, and a park then reads as a verdict. Three type-flow items were
  # parked that way and had to be reset by hand. The result event names the cause.
  limit="$(limit_reason)"
  if [[ "$before" == "$after" && -n "$limit" ]]; then
    echo
    echo "item $id stopped after ${elapsed}s (exit $claude_status): the result says '$limit'."
    echo "State left untouched, and the run is stopping so the queue is not parked behind it."
    echo "Resume with: ITEM=$id scripts/campaign.sh   after the limit resets or auth is fixed."
    exit 3
  fi

  if [[ "$before" == "$after" ]]; then
    echo "no state movement on item $id ($before) after ${elapsed}s (exit $claude_status) — parking it."
    # The work is often DONE and only the bookkeeping died — a phase writes
    # (phase, round) last. An opencode revise once exited 0 with five fixes not yet
    # committed. So the park note says what the worktree holds; also check reviews/
    # for lane reports before re-running this item.
    note="no progress in phase ${before%%:*} (exit $claude_status)"
    if [[ ! -d "$worktree" ]]; then
      note="$note; no worktree at $worktree"
    elif dirty="$(git -C "$worktree" status --porcelain 2>/dev/null)"; then
      if [[ -n "$dirty" ]]; then
        echo "uncommitted in $worktree:"
        printf '%s\n' "$dirty"
        count="$(printf '%s\n' "$dirty" | wc -l | tr -d ' ')"
        paths="$(printf '%s\n' "$dirty" | awk 'NR <= 3 { print substr($0, 4) }' | paste -s -d, -)"
        note="$note; worktree has $count uncommitted path(s): $paths — the work may be done, commit it before a re-run"
      else
        note="$note; worktree clean"
      fi
    else
      note="$note; git status failed in $worktree"
    fi
    park_item "$id" "$note"
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
