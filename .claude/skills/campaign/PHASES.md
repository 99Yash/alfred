# Campaign phases

Read **only** the section for the phase you were told to run. Each section ends with
the state write that closes the phase — if you skip it, the driver marks the item
stuck and resets your work.

Throughout: `$C` is the campaign dir (`.campaign/<slug>/`, absolute), `$S` is
`$C/state.json`, `$I` is the item file, `$WT` is the item's worktree path.

---

## Updating state

`state.json` is small and hand-editable. Read it, change the one item, write it back.
Every phase sets at minimum `phase` and `updatedAt`; most also set one more field.

```jsonc
{
  "slug": "arch-20260727",
  "source": ".campaign/arch-20260727/source.html",
  "baseBranch": "main",
  "policy": { "maxReviewRounds": 3, "stopAt": "merge", "isolation": "worktree" },
  "items": [
    {
      "id": "09",
      "slug": "dispatch-store-seam",
      "title": "Put a store seam under the dispatch gate",
      "strength": "Worth exploring",
      "phase": "design",          // next phase to run; terminal: landed|needs-human|skipped
      "round": 0,                 // review round, 1-based once review has run
      "prereqs": [],              // item ids that must be `landed` first
      "needsCoverage": false,     // routes through `cover` before `design`
      "branch": null,
      "worktree": null,
      "pr": null,
      "note": null,               // one line: why it's stuck / what's open
      "updatedAt": "2026-07-27T13:33:49Z"
    }
  ]
}
```

Timestamps come from `date -u +%Y-%m-%dT%H:%M:%SZ`. Never invent one.

---

## `intake`

Runs once per campaign. The only phase permitted to read the whole artifact.

1. Copy the artifact to `$C/source.html` so a TMPDIR sweep can't destroy the campaign.
2. Extract its text once. For an HTML report, strip `<script>`/`<style>`, unwrap
   tags, unescape entities — do not read the raw markup with the Read tool, and do
   not read it twice.
3. For each finding, write `$C/items/NN-slug.md` using the template below. **Copy the
   report's claims verbatim** — file paths, line numbers, the problem statement, the
   deletion test. You are transcribing, not summarizing, because no later phase gets
   to look at the source again.
4. Capture every gate the report states about a finding: prerequisite tests
   ("unsafe before that"), sequencing ("land X first"), ADR conflicts. These become
   `prereqs` / `needsCoverage` / a **Report gates** section — not prose a later
   phase has to notice.
5. Reconcile against reality before queueing: `git log --oneline -40` and a quick
   look at the cited lines. A finding already fixed gets `phase: "skipped"` and a
   note saying which commit did it. Reports go stale between writing and working.
6. Write `state.json` with the queue in the report's recommended order.

Item file template:

```markdown
# NN · <title>

- **Strength:** <Strong | Worth exploring | Speculative>
- **Source:** <artifact filename> · candidate NN
- **Files:** <verbatim from the report, with line numbers>

## Problem
<verbatim>

## Solution
<verbatim>

## Wins
<verbatim>

## Deletion test
<verbatim>

## Report gates
<prerequisite tests, sequencing, ADR notes — verbatim. "None stated." if none.>

## Design
_(design phase writes here)_

## Review
_(each review round appends here)_
```

**Close the phase:** every item gets `phase: "cover"` (if `needsCoverage`) or
`"design"`, except reconciled-away ones at `"skipped"`.

---

## `cover`

Only for items whose **Report gates** demand tests before the refactor. This exists
because "add a direct order table first; the refactor is cheap after that and unsafe
before it" is a real instruction, and an agent that reads it as flavor text will
refactor untested behavior.

1. `cd $WT` — or create the worktree first (see `implement` step 1), branch
   `test/campaign-<slug>-NN-coverage`.
2. Write **characterization tests only**. Pin the behavior that exists today,
   including behavior you suspect is wrong — a coverage PR that changes behavior has
   defeated its own purpose. If you find a bug, record it in the item file under
   Report gates and leave it failing-as-documented or xfail'd, with a comment.
3. `pnpm check` and the relevant test files must pass.
4. Commit, push, open a **non-draft** PR titled `test(<area>): pin <behavior> before
   campaign NN`. This one is meant to merge immediately and independently.
5. Append to the item file: what is now pinned, and what is still unpinned.

**Close the phase:** `phase: "design"`, `note` = the coverage PR number. Do not wait
for the merge — `design` reads source, not CI.

---

## `design`

The cheapest phase, and the one whose output you should expect a human to skim.

1. Read the item file. Read **only the cited files, and where possible only the cited
   line ranges**. If you need to know who calls something, that is an `Explore`
   subagent's job — ask it a question, get a conclusion, don't inherit its reads.
2. Check the ADRs the item touches (`decisions.md` index → the two or three relevant
   files under `docs/decisions/`). An item that contradicts a locked decision does
   not get implemented; it gets `needs-human` with the conflict written down.
3. Write the **Design** section of the item file:

   - **Invariant.** One sentence in the form `structural-review.md` demands: *given
     preconditions, after any allowed sequence of events and failures, property
     remains true.* "The refactor works" is not an invariant.
   - **Interface.** The exact signatures the deepened module exposes. Name the
     enforcement tier (1–5) each one buys, and be honest when it is 3 rather than 1.
   - **Edit list.** Every file, and what happens to it — including the deletions.
     An item whose deletion test said "concentrates" and whose edit list has no
     deletions has misunderstood itself.
   - **Vocabulary ledger.** Names a call site must know after, minus before. It must
     end negative. If it cannot, say which follow-up PR closes it.
   - **Test plan.** Which seam gets tested and how, given the new interface.
   - **Risk.** The one thing most likely to make this wrong.

4. Do **not** write implementation code. Do not create the branch.

**Close the phase:** `phase: "implement"`.

---

## `implement`

1. Worktree, from the repo root, against a fresh base:

   ```bash
   git fetch origin
   git worktree add -b refactor/campaign-<slug>-NN .claude/worktrees/<slug>-NN origin/<baseBranch>
   ```

   Record both `branch` and `worktree` in state **now**, before writing code — if
   this phase dies mid-way, the next invocation needs to find the tree.
2. `cd` into the worktree. Install if the item touches deps; otherwise the root
   `node_modules` symlink layout already works.
3. Implement the Design section. **TDD at the seam the design named** — the test
   that fails for the right reason first. The repo's own guidance applies: derive
   source-of-truth shapes, validate `unknown` at the owning boundary, `db:generate`
   + `db:migrate` (never `db:push`).
4. Deviations from the design are allowed and expected — record them in the item
   file under Design as `Deviation: <what> — <why>`. An undocumented deviation is
   what makes the review round misfire.
5. `pnpm check` and the full test suite must pass. If you cannot get there, do not
   push a red branch: write what blocked you into the item file, set
   `phase: "needs-human"` with a one-line `note`, and stop.
6. Commit, push, and open a **draft** PR. Body states the invariant from the design,
   the vocabulary ledger, and `Refs #N` for any issue the item maps to — closing
   keywords only where the PR fully resolves one.

**Close the phase:** `phase: "review"`, `round: 0`, `pr` = the number.

---

## `review`

See **[REVIEW.md](REVIEW.md)** — this phase is entirely that protocol. In short:
three subagents in parallel over `git diff <base>...HEAD`, a synthesis you do
yourself, and a verdict.

**Close the phase:**
- must-fix findings exist and `round < maxReviewRounds` → `phase: "revise"`, `round: round + 1`
- must-fix findings exist and `round >= maxReviewRounds` → `phase: "needs-human"`,
  `note` = the count and the sharpest one
- no must-fix → `phase: "land"`

---

## `revise`

1. `cd $WT`. Read **only** the must-fix list from the latest review round in the item
   file. Not the raw subagent output; not the earlier rounds.
2. Fix them. Nothing else. A follow-up that tempts you is a new queue item — append
   it to `state.json` with `phase: "design"` and write its item file, then leave it.
3. `pnpm check`, tests, commit, push.
4. Append to the review round section: how each must-fix was closed, or why it is
   being disputed. A disputed finding is legitimate — argue it in one paragraph
   against the doc's own gates, and the next review round adjudicates it.

**Close the phase:** `phase: "review"`.

---

## `land`

1. `gh pr ready <pr>` — out of draft.
2. Final comment on the PR: the invariant, the down-conclusion (closed within scope /
   unproven with named residual risk), and the review rounds it took.
3. Append any follow-ups the review deferred as **new items** in `state.json`, each
   with its own item file. This is where scope discovered mid-item goes to live.
4. Leave the worktree in place — the human is merging, not you. Cleanup is
   `git worktree remove` after the merge.

**Close the phase:** `phase: "landed"`.
