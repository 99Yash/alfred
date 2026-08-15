# Campaign phases

Read **only** the section for the phase you were told to run. Each section ends with
the state write that closes the phase — if you skip it, the driver marks the item
stuck and resets your work.

Throughout: `$C` is the campaign dir (`.campaign/<slug>/`, absolute), `$S` is
`$C/state.json`, `$I` is the item file, `$WT` is the item's worktree path.

---

## Updating state

**Write it through `scripts/campaign-state.mjs`, never by hand.** `state.json` holds every
item, so a hand edit is a whole-file rewrite: two phases running at once each read the same
bytes, edit their own item, and the later write silently drops the earlier one — the losing
item keeps its old `phase` and the driver re-runs a phase that already ran. The script takes
a lock, changes the one item, stamps `updatedAt`, and renames the file into place. It is the
only reason more than one lane can run at a time.

```bash
CS="$(cd "$C/../.." && pwd)/scripts/campaign-state.mjs"

node "$CS" set --state "$S" --id 09 phase=review round=1 pr=764
node "$CS" set --state "$S" --id 09 phase=needs-human note="one line why"
node "$CS" set --state "$S" --id 09 prereqs=39,187      # a prereq the design discovered
node "$CS" add --state "$S" --item-slug fence-the-door --title "Fence the door" --prereqs 09
node "$CS" note --state "$S" "- [09 design] the fact another item needs"
node "$CS" get  --state "$S" --id 09
```

**`add` assigns the id — never choose one yourself.** Two phases that both read the queue and
both conclude "the next id is 78" write the same id, and the second silently renames the
first one's item. `add` prints the id it gave you and the `items/<id>-<slug>.md` path the
item file must go to; `campaign.sh` resolves that exact path from the id and slug and exits
if the file is missing, so write it before you finish.

Resolve it from `$C` like that, **not** as `scripts/campaign-state.mjs`. Your cwd is the
item's worktree, and a worktree branched before this script landed does not contain it —
`$C` is always in the main checkout, two levels above the campaign dir, so the same command
works from every worktree regardless of what its branch point held.

`note` appends to `NOTES.md` under the same lock, for the same reason. `round` and `pr` are
written as numbers, `null` as JSON null; the literal `updatedAt` is never passed by hand. A
phase name outside the known set is refused rather than written.

`prereqs` takes a comma-separated list and is written as an array. An empty value clears it.
Every id must name an item in the same campaign, and an item may not be its own prereq;
`set` refuses the whole command otherwise and writes nothing. So a `design` phase that
discovers a prerequisite records it here, under the lock, instead of editing `state.json`.

Every phase sets at minimum `phase`; most also set one more field. The shape it maintains:

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

`set` stamps `updatedAt` itself, so no phase formats a timestamp. Any timestamp you write
elsewhere comes from `date -u +%Y-%m-%dT%H:%M:%SZ`. Never invent one.

---

## Every phase: what to read first, and when to write

**Read `$C/NOTES.md` before you start** (create it empty if absent). It is the
campaign's shared scratchpad — facts one item learned that another item needs.
Item 07 and item 08 both live in `use-chat-stream.ts`; without this, the second one
rediscovers what the first already knew. Append to it — through
`campaign-state.mjs note`, never with an editor — when you learn something an
item *other than yours* would want:

```markdown
- [07 design] `apps/web/test/` has no jsdom; DOM-free leaves are testable under
  node:test, matching `test/events/replay-state.test.ts`.
- [07 implement] web test files were unchecked by any tsc until this item added
  `apps/web/tsconfig.test.json`.
```

Keep it under ~60 lines. It is a scratchpad, not an archive — if a fact is durable
and repo-wide rather than campaign-local, it belongs in `.lessons/` via `/learn`
(see `land`), where the recall hook will surface it in future sessions
automatically.

**Checkpoint as you go; do not save everything for the end.** A phase that writes
only on success loses everything when it is killed, runs out of budget, or crashes —
which has already happened once here: a `cover` phase built its worktree, learned
what it needed, died, and left no trace. So:

- Write `branch` and `worktree` into state the moment they exist, before any code.
- Append findings to the item file **as they land**, not in one final flush.
- Before any step likely to be long or to fail — a big refactor, a full test run, a
  review lane — write down what you already know.

**Record dead ends, not just conclusions.** A `Considered and rejected` list in the
item file is the cheapest thing the next phase can read, and its absence is why
`implement` re-explores ground `design` already covered:

```markdown
### Considered and rejected
- Re-exporting the moved symbols from the old module — keeps the 18-export interface
  the change exists to shrink (see .lessons/extract-state-schema-before-protocol-modules.md).
```

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
5. **Reconcile against reality before queueing. Do not skim this step** — it is the
   one that has actually failed in practice. An architecture report is a snapshot of
   a tree someone is *actively working*, and three of this campaign's first ten
   candidates were hand-landed in the seven hours between the report's timestamp and
   intake. Queueing merged work is the most expensive mistake this phase can make,
   because nothing downstream re-checks it.

   All four of these, not just the first:

   ```bash
   git log --oneline --since="<artifact timestamp> -7 days" | head -60
   gh pr list --state merged --limit 30 \
     --json number,title,mergedAt --template '{{range .}}#{{.number}} {{.mergedAt}} {{.title}}{{"\n"}}{{end}}'
   gh pr list --state open --limit 30 --json number,title,headRefName
   git for-each-ref --sort=-committerdate --format='%(refname:short) %(contents:subject)' refs/remotes/origin | head -20
   ```

   Match on the *finding*, not the branch name — a PR titled differently can still
   have done the work, and a report candidate can be partially landed. Then read the
   cited lines: if they no longer say what the report quoted, the finding moved or
   died.

   Record the verdict per item:
   - fully landed → `phase: "skipped"`, note naming the PR and merge time, and a
     banner at the top of the item file so a human reading it later is not misled
   - partially landed → keep it queued, and write what *remains* into the item file
   - merged work invalidated another item's premise → say so in that item's **Report
     gates**. Sequencing advice expires: "land #9 first so #1 and #2 are tested"
     means nothing once #1 and #2 have landed without it.
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

1. Create or reuse the worktree exactly as `implement` step 1 describes — the same
   idempotent block, with branch `test/campaign-<slug>-NN-coverage`. Record
   `worktree` and `branch` in state **before** writing tests, then `cd $WT`.
2. Write **characterization tests only**. Pin the behavior that exists today,
   including behavior you suspect is wrong — a coverage PR that changes behavior has
   defeated its own purpose. If you find a bug, record it in the item file under
   Report gates and leave it failing-as-documented or xfail'd, with a comment.
3. `pnpm check && pnpm check-types` and the relevant test files must pass. Note that
   `pnpm check` runs lint, format, and boundary checks but **no `tsc`** — typechecking
   is the separate `pnpm check-types`. Naming only the first lets type errors land.
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

1. Worktree, from the repo root, against a fresh base. **This must be idempotent** —
   a phase killed mid-way leaves the tree and branch behind, and a retry that
   assumes a clean slate fails on `already exists` and gets itself parked:

   ```bash
   git fetch origin
   WT=.claude/worktrees/<slug>-NN
   BR=refactor/campaign-<slug>-NN
   if [ -d "$WT" ]; then
     git -C "$WT" rev-parse --abbrev-ref HEAD    # reuse it; confirm it's on $BR
   elif git show-ref --verify --quiet "refs/heads/$BR"; then
     git worktree add "$WT" "$BR"                # branch survived, tree didn't
   else
     git worktree add -b "$BR" "$WT" origin/<baseBranch>
   fi
   ```

   A reused tree may hold a half-finished attempt. Inspect `git status` and
   `git log origin/<baseBranch>..HEAD` before writing anything, and say in the item
   file what you found — resuming on top of an abandoned edit you never looked at is
   how a phase produces a diff nobody can explain.

   Record both `branch` and `worktree` in state **now**, before writing code — if
   this phase dies mid-way, the next invocation needs to find the tree.
2. `cd` into the worktree, then **`pnpm install --frozen-lockfile` before any command
   that runs code** (~8 s). A new worktree is a fresh checkout of tracked files only, so
   it has no `node_modules` of its own. The repo root's copy does not cover it: a
   worktree lives under `.claude/worktrees/`, so Node's upward search does reach
   `<repo>/node_modules`, but that directory holds neither the workspace links
   (pnpm links `@alfred/*` per package, into `packages/<name>/node_modules`) nor the
   per-package binaries (`tsx` is a devDependency at
   `packages/<name>/node_modules/.bin/tsx`, absent from the root `.bin`). So `tsx` and
   every `@alfred/*` import fail until you install. A reused worktree already has one —
   check before paying for it again.

   **A worktree also carries no `apps/server/.env`**, so `--env-file-if-exists` silently
   supplies nothing and the DB-backed suites skip while printing `# skipped 0`. Point
   `--env-file` at the main checkout's absolute path and prove the run by the suite-name
   list, per step 5.
3. Implement the Design section. **TDD at the seam the design named** — the test
   that fails for the right reason first. The repo's own guidance applies: derive
   source-of-truth shapes, validate `unknown` at the owning boundary, `db:generate`
   + `db:migrate` (never `db:push`).
4. Deviations from the design are allowed and expected — record them in the item
   file under Design as `Deviation: <what> — <why>`. An undocumented deviation is
   what makes the review round misfire.
5. `pnpm check && pnpm check-types` and the full test suite must pass — `pnpm check`
   alone does not typecheck. Confirm the DB-backed suites actually **ran** rather than
   skipping on a missing `DATABASE_URL`; a skip is not a pass. If you cannot get
   there, do not
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
2. Fix them. Nothing else. A follow-up that tempts you is a new queue item — queue it
   with `campaign-state.mjs add` (below), write the item file at the path it prints,
   then leave it.
3. `pnpm check && pnpm check-types`, tests, commit, push.
4. Append to the review round section: how each must-fix was closed, or why it is
   being disputed. A disputed finding is legitimate — argue it in one paragraph
   against the doc's own gates, and the next review round adjudicates it.

**Close the phase:** `phase: "review"`.

---

## `land`

1. `gh pr ready <pr>` — out of draft.
2. Final comment on the PR: the invariant, the down-conclusion (closed within scope /
   unproven with named residual risk), and the review rounds it took.
3. Queue any follow-ups the review deferred as **new items** with
   `campaign-state.mjs add`, each with its own item file at the path `add` prints. This
   is where scope discovered mid-item goes to live.
4. **If this item produced a durable, repeatable lesson, run `/learn`.** Not a
   summary of the change — the repo's git history already holds that. The bar is a
   non-obvious, costly, *recurring* trap: the ordering that has to happen first, the
   check that lies, the shape that cycles if you build it the other way. `.lessons/`
   is the one continuity mechanism that outlives the campaign, and the recall hook
   surfaces it unprompted in later sessions. Prune anything campaign-local to
   `NOTES.md` instead.
5. Leave the worktree in place — the human is merging, not you. Cleanup is
   `git worktree remove` after the merge.

**Close the phase:** `phase: "landed"`.
