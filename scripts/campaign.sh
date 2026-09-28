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
#   DRY_RUN         default 0
#   ENGINE          which CLI runs a phase: `claude` (default), `opencode`, or `codex`.
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
#                   `codex` (`codex exec`) differs on budgets the same way: it takes
#                   no per-run USD cap, so MAX_ITER is again the only ceiling. It
#                   loads AGENTS.md, and layers its own ~/.codex/config.toml on top.
#                   It runs sandboxed — see SANDBOX.
#   WRITE_ENGINE    engine for the two phases that EDIT code and push — `implement`
#                   and `revise`. Defaults to `$ENGINE`. Setting it separately is
#                   how one campaign runs its write phases on a different model from
#                   its read phases, e.g.
#                     ENGINE=codex WRITE_ENGINE=opencode MODEL=opencode/space-bunny-free
#                   runs design/review/land under codex and implement/revise under
#                   opencode. Rationale: the write phases are the ones that must not
#                   be cheap, and the read phases are the ones that want the stronger
#                   reader. Cost: the two engines share no session, so the handoff
#                   between them is the item file and nothing else.
#   MODEL           model for ENGINE=opencode / WRITE_ENGINE=opencode, as
#                   `provider/model`. Default
#                   `opencode/muse-spark-1.3-contributor-free`. Ignored otherwise.
#   CODEX_MODEL     model for codex phases. Default `gpt-5.6-sol`.
#                   NOT `gpt-6-sol`: that id is refused under
#                   `auth_mode = "chatgpt"` ("not supported when using Codex with a
#                   ChatGPT account") and is absent from ~/.codex/models_cache.json.
#                   On an API-key login, override this.
#   CODEX_EFFORT    codex `model_reasoning_effort`. Default `high`. The key lives
#                   in ~/.codex/config.toml, which is where it is read from when
#                   unset here.
#   SANDBOX         codex sandbox policy: `workspace-write` (default) or
#                   `danger-full-access`. A push phase needs network for `git push`
#                   and `gh pr create`; if one fails on a network refusal, that is
#                   this knob.

set -euo pipefail

MAX_ITER="${MAX_ITER:-20}"
MAX_BUDGET_USD="${MAX_BUDGET_USD:-8}"
REVIEW_BUDGET_USD="${REVIEW_BUDGET_USD:-12}"
MIN_PHASE_SECONDS="${MIN_PHASE_SECONDS:-15}"
DRY_RUN="${DRY_RUN:-0}"
ITEM="${ITEM:-}"
ENGINE="${ENGINE:-claude}"
MODEL="${MODEL:-opencode/muse-spark-1.3-contributor-free}"
WRITE_ENGINE="${WRITE_ENGINE:-$ENGINE}"
CODEX_MODEL="${CODEX_MODEL:-gpt-5.6-sol}"
CODEX_EFFORT="${CODEX_EFFORT:-high}"
SANDBOX="${SANDBOX:-workspace-write}"

# Validation runs against BOTH engines, not just $ENGINE. WRITE_ENGINE defaults to
# $ENGINE, so a run that sets only WRITE_ENGINE would otherwise validate a typo and
# carry it silently until the push phase failed two phases into the item.
for _eng in "$ENGINE" "$WRITE_ENGINE"; do
  case "$_eng" in
    claude|opencode|codex) ;;
    *) echo "unknown engine $_eng — expected claude, opencode, or codex" >&2; exit 1 ;;
  esac
  command -v "$_eng" >/dev/null || { echo "$_eng is not on PATH" >&2; exit 1; }
done

case "$SANDBOX" in
  workspace-write|danger-full-access) ;;
  *) echo "unknown SANDBOX $SANDBOX — expected workspace-write or danger-full-access" >&2; exit 1 ;;
esac

# Which engine runs one phase. `implement` and `revise` are the write phases —
# they edit files, commit, push, and open PRs. Every other phase the loop reaches
# (`cover`, `design`, `review`, `land`) only reads the repo and writes the item
# file and state.json.
engine_for_phase() {
  case "$1" in
    implement|revise) printf '%s' "$WRITE_ENGINE" ;;
    *)                printf '%s' "$ENGINE" ;;
  esac
}

engine_label() {
  case "$1" in
    opencode) printf '%s (%s)' "$1" "$MODEL" ;;
    codex)    printf '%s (%s, effort %s)' "$1" "$CODEX_MODEL" "$CODEX_EFFORT" ;;
    *)        printf '%s' "$1" ;;
  esac
}

# Name each distinct engine once. When the write phases run elsewhere the header has
# to say so, or an operator reading a mid-run banner cannot tell which model is
# about to touch the worktree.
if [[ "$WRITE_ENGINE" != "$ENGINE" ]]; then
  MODEL_LABEL="read phases: $(engine_label "$ENGINE") | write phases: $(engine_label "$WRITE_ENGINE")"
else
  MODEL_LABEL="$(engine_label "$ENGINE")"
fi

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

echo "campaign: $SLUG   base: $BASE_BRANCH   engines: $MODEL_LABEL   budget: \$$MAX_BUDGET_USD/iter, \$$REVIEW_BUDGET_USD for review"
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

  phase_engine="$(engine_for_phase "$phase")"

  echo
  echo "===== iteration $i/$MAX_ITER · item $id · phase $phase (round $round) · budget \$$iter_budget · engine $(engine_label "$phase_engine") ====="
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

  # Three engines, and only two of them share an event schema. `claude` streams
  # `stream_event`/`assistant`/`result`; `opencode --format json` streams
  # `text`/`tool_use`/`step_finish` with the payload under `.part`. One jq filter
  # reads both so the console looks the same.
  #
  # `codex` is NOT run through that filter. Its `--json` event schema is not
  # something this script should be coupled to for cosmetics, so codex runs on its
  # plain-text stdout, which already narrates its own progress, and `cat` carries
  # it through. Same FIFO, same liveness property, no guessed jq paths.
  if [[ "$phase_engine" == "codex" ]]; then
    cat < "$fifo" &
  else
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
      ' < "$fifo" &
  fi
  JQ_PID=$!

  set +e
  case "$phase_engine" in
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
          --model "$MODEL" \
          --auto \
          --format json > "$fifo" &
      ;;
    codex)
      # Same no-budget-flag caveat as opencode: MAX_ITER is the only ceiling.
      #
      # `--add-dir` is the load-bearing flag. A phase's working root is the repo,
      # but the item file and state.json it MUST write live in .campaign/, and a
      # workspace-write sandbox refuses writes outside that root without it — so a
      # phase would fail at its LAST step, after the thinking was already paid for
      # and the code already written. `-c approval_policy=never` matches the
      # unattended posture the other two engines take (bypassPermissions / --auto):
      # the loop has nobody to answer a prompt, and a blocked prompt is
      # indistinguishable from a hang.
      #
      # `--ephemeral` mirrors claude's --no-session-persistence: one phase per
      # process, nothing carried between iterations.
      printf '%s' "$prompt" | codex exec \
          -C "$REPO_ROOT" \
          --model "$CODEX_MODEL" \
          -c "model_reasoning_effort=$CODEX_EFFORT" \
          -c "approval_policy=never" \
          -s "$SANDBOX" \
          --add-dir "$CAMPAIGN_DIR" \
          --ephemeral > "$fifo" &
      ;;
  esac
  CHILD_PID=$!
  wait "$CHILD_PID"
  phase_status=$?
  CHILD_PID=""   # the trap has already reaped it on the interrupt path
  wait "$JQ_PID" 2>/dev/null
  JQ_PID=""
  set -e
  rm -f "$fifo"

  elapsed=$(( $(date +%s) - started_at ))
  after="$(signature "$id")"

  # 130 = SIGINT, 143 = SIGTERM. An operator kill is not a stuck item.
  if [[ "$INTERRUPTED" == "1" || "$phase_status" == "130" || "$phase_status" == "143" ]]; then
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
    echo "item $id exited after only ${elapsed}s (exit $phase_status) — the phase never ran."
    echo "Most likely a usage limit; also possible: auth, or a prompt-render failure."
    echo "State left untouched, and the run is stopping so the queue is not parked behind it."
    echo "Resume with: scripts/campaign.sh   (or ITEM=$id scripts/campaign.sh)"
    exit 3
  fi

  if [[ "$before" == "$after" ]]; then
    echo "no state movement on item $id ($before) after ${elapsed}s (exit $phase_status) — parking it."
    # The work is often DONE and only the bookkeeping died — a phase writes
    # (phase, round) last. Check the worktree for uncommitted edits and reviews/ for
    # lane reports before re-running this item; see NOTES.md, "Campaign hygiene".
    park_item "$id" "no progress in phase ${before%%:*} (exit $phase_status)"
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
