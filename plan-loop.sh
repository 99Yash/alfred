#!/usr/bin/env bash
set -euo pipefail

# plan-loop.sh — headless, gated, multi-session plan executor.
#
# Loops fresh `claude -p` sessions against a checkbox ledger (.loop/plan.md)
# until every step is done, then runs a final structural-review pass. Each
# session gets a CLEAN context window (that's the whole point — you never
# approach the ~140k fidelity cliff, because every iteration starts fresh and
# works one bounded slice). Continuity across sessions rides on:
#   - .loop/plan.md   the machine-checkable ledger (source of truth for "done?")
#   - .handoff/*.md   the narrative ore each session leaves for the next
#
# GATED autonomy: the loop runs without per-tool prompts, but each iteration
# must pass the authoritative gate (check-types, + optional tests) BEFORE its
# work is committed. A red gate STOPS the loop for you to inspect — nothing is
# committed, the working tree is left as-is.
#
# Usage:   ./plan-loop.sh            # run the loop
#          MAX_ITERS=8 ./plan-loop.sh
#          TESTS="pnpm --filter @alfred/api test" ./plan-loop.sh
#          DRY_RUN=1 ./plan-loop.sh  # print what it would do, run nothing
#
# Prereqs: fill in .loop/plan.md with your steps first (see .loop/README.md).

# ---- config (override via env) ----------------------------------------------
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOOP_DIR="$ROOT/.loop"
LEDGER="$LOOP_DIR/plan.md"
LOGDIR="$LOOP_DIR/logs"
REVIEW="$LOOP_DIR/review.md"
BASE_SHA_FILE="$LOOP_DIR/base.sha"

MAX_ITERS="${MAX_ITERS:-20}"                 # hard cap: runaway-loop backstop
GATE="${GATE:-pnpm check-types}"             # authoritative gate, always run
TESTS="${TESTS:-}"                           # optional extra gate, e.g. api tests
MODEL="${MODEL:-}"                           # optional: e.g. MODEL=opus
STALL_LIMIT="${STALL_LIMIT:-2}"             # stop after N iters with no box checked
DRY_RUN="${DRY_RUN:-0}"
REVIEW_MARK="@structural-review"             # tag identifying the final review step
# Unattended => no interactive tool prompts. Gate + branch guard + per-iter
# commit are the safety net. Override to e.g. "--permission-mode acceptEdits".
CLAUDE_PERM="${CLAUDE_PERM:---dangerously-skip-permissions}"

CLAUDE_BIN="${CLAUDE_BIN:-claude}"

c_reset='\033[0m'; c_dim='\033[2m'; c_grn='\033[32m'; c_red='\033[31m'; c_ylw='\033[33m'; c_cyn='\033[36m'
say()  { printf "${c_cyn}[loop]${c_reset} %b\n" "$*"; }
ok()   { printf "${c_grn}[loop]${c_reset} %b\n" "$*"; }
warn() { printf "${c_ylw}[loop]${c_reset} %b\n" "$*"; }
die()  { printf "${c_red}[loop] %b${c_reset}\n" "$*" >&2; exit 1; }

# ---- preflight --------------------------------------------------------------
command -v "$CLAUDE_BIN" >/dev/null 2>&1 || die "claude CLI not found on PATH"
[ -f "$LEDGER" ] || die "no ledger at $LEDGER — copy .loop/plan.md and fill it in (see .loop/README.md)"

BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
[ "$BRANCH" = "main" ] && die "refusing to run on 'main' — switch to a feature branch first"
[ "$BRANCH" = "?" ]    && die "not a git repo (need git for per-iteration commits + review base)"

mkdir -p "$LOGDIR"

# Record the diff base once, so the final review sees the whole loop's changes.
if [ ! -f "$BASE_SHA_FILE" ]; then
  git -C "$ROOT" rev-parse HEAD > "$BASE_SHA_FILE"
  say "recorded review base: $(cat "$BASE_SHA_FILE")"
fi
BASE_SHA="$(cat "$BASE_SHA_FILE")"

count_open()   { grep -cE '^\s*- \[ \]' "$LEDGER" || true; }
count_done()   { grep -cE '^\s*- \[[xX]\]' "$LEDGER" || true; }
open_nonreview(){ grep -E '^\s*- \[ \]' "$LEDGER" | grep -vF "$REVIEW_MARK" | wc -l | tr -d ' '; }
open_review()  { grep -E '^\s*- \[ \]' "$LEDGER" | grep -cF "$REVIEW_MARK" || true; }

# ---- prompt builders --------------------------------------------------------
iterate_prompt() {
cat <<EOF
You are ONE iteration of an autonomous, multi-session plan loop. Your context
window is fresh and disposable; another session ran before you and another will
run after. Continuity lives in two files, NOT in your memory:

  - Ledger (source of truth): $LEDGER
  - Handoffs (narrative):     newest under .handoff/ (\`ls -t .handoff/ | head\`)

Do this, in order:

1. Read the ledger. Read the single newest .handoff/ doc for context on what the
   previous session did, tried, and left. Do NOT re-walk its dead ends.

2. Pick the FIRST unchecked \`- [ ]\` step (or the smallest coherent slice of it
   that fits comfortably in one clean context — do NOT try to do the whole plan).
   Skip the step tagged $REVIEW_MARK; that is handled by a separate final pass.

3. Implement exactly that slice. Follow CLAUDE.md, AGENTS.md, and the repo
   invariants. Reuse existing helpers before writing new ones.

4. VERIFY before you claim done. Run: \`$GATE\`${TESTS:+ and \`$TESTS\`}.
   - If green: mark ONLY the step(s) you fully finished as \`- [x]\` in the ledger.
   - If red or blocked: leave the box UNCHECKED. Do not fake progress.

5. Write a handoff (invoke your \`handoff\` skill, or write .handoff/<utc-ts>.md
   directly): the chronological progression, current state, exact next step, and
   any blocker with its evidence. This is what the next fresh session resumes from.

Constraints:
  - Do NOT git commit — the orchestrator commits after gating your work.
  - Bounded slice only. A smaller, verified step beats an ambitious broken one.
  - If the step is genuinely blocked, say so clearly in the handoff and stop.
EOF
}

review_prompt() {
cat <<EOF
You are the FINAL structural-review pass of an autonomous plan loop. All
implementation steps in $LEDGER are checked off. Your job is to review — not to
keep building.

1. Read docs/reference/structural-review.md — that is the method you must apply.
2. Review the full diff of this loop's work: \`git diff $BASE_SHA...HEAD\` (and any
   uncommitted changes). Classify files as authored sources vs generated artifacts.
3. Run the review as specified: orient, map the domain, look UP (structural
   discovery via the six axes), sweep the surface (docs/reference/code-style.md),
   and drill DOWN on the invariants that earn depth. Honor the forcing function:
   at least one up-observation, and a closed/broken/unproven conclusion for every
   claim that earned depth.
4. Write your findings to $REVIEW as a structured report (severity-ranked). Do NOT
   apply fixes — this is gated; the human decides what to act on.
5. Mark the \`$REVIEW_MARK\` step in the ledger as \`- [x]\`.
EOF
}

run_claude() {
  local prompt="$1" logfile="$2"
  local -a args=(-p "$prompt" $CLAUDE_PERM)
  [ -n "$MODEL" ] && args+=(--model "$MODEL")
  if [ "$DRY_RUN" = "1" ]; then
    warn "DRY_RUN: would run: $CLAUDE_BIN ${args[0]} '<prompt>' ${args[*]:2}"
    return 0
  fi
  # Stream to console AND capture to a per-iteration log.
  "$CLAUDE_BIN" "${args[@]}" 2>&1 | tee "$logfile"
}

run_gate() {
  say "gate: $GATE"
  ( cd "$ROOT" && eval "$GATE" ) || return 1
  if [ -n "$TESTS" ]; then
    say "gate: $TESTS"
    ( cd "$ROOT" && eval "$TESTS" ) || return 1
  fi
  return 0
}

# ---- main loop --------------------------------------------------------------
say "branch: ${c_grn}$BRANCH${c_reset}   ledger: $LEDGER   base: ${BASE_SHA:0:8}"
say "open steps: $(count_open)   done: $(count_done)   max iters: $MAX_ITERS"

stall=0
iter=0
while [ "$iter" -lt "$MAX_ITERS" ]; do
  open_total="$(count_open)"

  # Done? (nothing unchecked at all)
  if [ "$open_total" -eq 0 ]; then
    ok "ledger fully checked — plan complete."
    break
  fi

  # Only the review step left => run the final review pass and finish.
  if [ "$(open_nonreview)" -eq 0 ] && [ "$(open_review)" -ge 1 ]; then
    say "${c_ylw}final structural-review pass${c_reset}"
    ts="$(date -u +%Y%m%dT%H%M%SZ)"
    run_claude "$(review_prompt)" "$LOGDIR/review-$ts.log"
    if [ "$DRY_RUN" != "1" ]; then
      git -C "$ROOT" add -A
      git -C "$ROOT" commit -q -m "chore(loop): structural review pass

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" || warn "nothing to commit for review pass"
    fi
    ok "review written to $REVIEW — inspect it. Loop done."
    break
  fi

  iter=$((iter+1))
  done_before="$(count_done)"
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  say "${c_dim}────────${c_reset} iteration $iter/$MAX_ITERS  (open: $open_total)  ${c_dim}$ts${c_reset}"

  run_claude "$(iterate_prompt)" "$LOGDIR/iter-$iter-$ts.log"
  [ "$DRY_RUN" = "1" ] && { warn "DRY_RUN: stopping after one simulated iteration"; break; }

  # Authoritative gate — do NOT trust the agent's self-report.
  if ! run_gate; then
    die "gate FAILED after iteration $iter. Nothing committed; working tree left as-is for inspection.\n      Log: $LOGDIR/iter-$iter-$ts.log"
  fi
  ok "gate passed"

  done_after="$(count_done)"

  # Stall detection: gate green but no box advanced.
  if [ "$done_after" -le "$done_before" ]; then
    stall=$((stall+1))
    warn "no ledger progress this iteration (stall $stall/$STALL_LIMIT)"
    if [ "$stall" -ge "$STALL_LIMIT" ]; then
      die "stalled: $STALL_LIMIT iterations with a green gate but no step checked off.\n      Likely the current step is under-specified or blocked. See newest .handoff/ and $LOGDIR."
    fi
  else
    stall=0
    # Commit the verified slice.
    git -C "$ROOT" add -A
    git -C "$ROOT" commit -q -m "chore(loop): iteration $iter — $((done_after-done_before)) step(s) done, gate green

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" || warn "nothing to commit"
    ok "committed iteration $iter  (done: $done_after/$((done_after+$(count_open))))"
  fi
done

if [ "$iter" -ge "$MAX_ITERS" ] && [ "$(count_open)" -gt 0 ]; then
  warn "hit MAX_ITERS=$MAX_ITERS with $(count_open) step(s) still open. Bump MAX_ITERS or inspect the ledger."
fi

say "logs: $LOGDIR   ledger: $LEDGER"
