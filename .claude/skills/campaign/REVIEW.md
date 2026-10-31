# The review round

One review round = **three subagents in parallel**, then a synthesis you perform in
this context, then a verdict. The subagents do the reading; only their reports come
back. That is what keeps round 3 as cheap as round 1.

The governing document is [`docs/reference/structural-review.md`](../../../docs/reference/structural-review.md).
It is not summarized here — each brief tells its agent which part to read. Its worked
examples are in `docs/reference/structural-review-exemplars.md`; an agent reads them
only when a rule is not clear enough to apply. What is here is
the part that document leaves to the reviewer: how to run it _harshly_, and what
counts as done.

## Setup

```bash
cd $WT
git fetch origin
BASE=$(git merge-base origin/<baseBranch> HEAD)
git diff --stat $BASE...HEAD
```

Pass `$BASE` and the worktree path to every subagent. Give each of them the item
file's **Design** section — the invariant and the ledger are the claims under review,
and a reviewer who has to guess the claim will review the diff's shape instead.

**Refresh before reviewing.** If the PR moved since the last round, re-derive
`$BASE` and re-read HEAD. Reviewing a stale diff is the failure mode
`.lessons/refresh-pr-head-before-final-review.md` exists to prevent.

## Lane 1 — structural **up**

> You are reviewing PR #<n> in worktree <path>, diff `<base>...HEAD`.
>
> Read `docs/reference/structural-review.md`: the motions, the domain map, the six
> axes, required knowledge, the admission gates, and the summary pass. Then run
> **only the up-pass**: passes 1, 2, and the up half of 5. Do not run the checklist
> sweep — another agent owns it.
>
> The change claims this invariant: `<invariant>`. Its stated vocabulary ledger is:
> `<ledger>`.
>
> Produce, in this order:
>
> 1. The domain map — only the dimensions that can make or break the invariant.
>    Say which you skipped and why.
> 2. At least one up-observation from the six axes, or an explicit statement that
>    you ran the pointers for the axes this diff touches and none applies, with the
>    reason. Silence is not an option the forcing function allows.
> 3. The **required-knowledge test on every call site the diff adds or changes**:
>    write the naive version of the call, list every way it is now wrong, and name
>    the enforcement tier where the correct knowledge lives. Tier 4–5 residue is a
>    finding even when nothing has a second home.
> 4. The vocabulary ledger, recomputed by you. If the PR's own claim of negative is
>    wrong, say so.
> 5. Every up-finding run through admission gates A–D. **A finding that cannot
>    clear the gates does not go in the report.** Taste dressed as structure is
>    worse than no review.
>
> Tag each finding `must-fix`, `follow-up`, or `nit`. `must-fix` means: merging
> this makes a future change materially harder or a rule unenforceable, and the fix
> belongs in this PR. Be sparing — three must-fixes that are real beats twelve that
> are opinions.
>
> Write your report to `<campaign>/reviews/NN-rN-up.md`. Do not edit source.

## Lane 2 — structural **down**

> You are reviewing PR #<n> in worktree <path>, diff `<base>...HEAD`.
>
> Read `docs/reference/structural-review.md`: the motions, the drilling-down
> section, and the down half of the admission gates. Then run **only the
> down-pass**: passes 1, 4, and the drilling-down section.
>
> The change claims this invariant: `<invariant>`.
>
> Your job is falsification. For each claim that earns depth — multi-step writes,
> queues, external effects, caches, retries, migrations, changed guards, changed
> persisted representations, moved ownership — **try to construct a breaking
> sequence before you try to confirm the claim.** Trace through the system, through
> time, and down to the layer that actually decides.
>
> Every claim ends with one of exactly three conclusions: **closed within scope**
> (name the paths and assumptions, and the evidence), **broken** (give the
> precondition, event order, failure point, resulting state, and consequence), or
> **unproven** (name the missing evidence and the residual risk). "Looks correct"
> is not a conclusion and will be rejected. If nothing earned depth, say why the
> change is low-risk enough not to trace.
>
> A green test whose mock chose not to model the failure is not evidence. Where the
> invariant depends on Postgres, the queue, the provider, or the browser, read the
> substrate contract or run the smallest probe.
>
> Tag findings `must-fix` (broken, or unproven where the residual risk is
> unacceptable), `follow-up`, or `nit`. Write to
> `<campaign>/reviews/NN-rN-down.md`. Do not edit source.

## Lane 3 — bounded sweep

> You are reviewing PR #<n> in worktree <path>, diff `<base>...HEAD`.
>
> Run the bounded surface sweep from `docs/reference/review-checklist.md` across the
> **authored** changed files. Classify first: authored sources get the sweep;
> generated artifacts (lockfiles, generated SQL, snapshots) get _reconciled_ against
> their source and the intended delta — did generation emit only what was intended,
> is the resolution expected, is any operation destructive or reordered — and are
> never style-reviewed.
>
> The checklist holds only the rules that no gate enforces. Every gate rule is in
> `docs/reference/enforced-rules.md`, which a script generates. Do NOT report a
> violation of a rule in that catalog as a finding: `pnpm check` already fails on
> it. When a finding names a new review rule, propose a checklist line and a queue
> row in `docs/reference/gate-design.md`. When the PR adds a gate rule, check that
> it deleted the matching checklist line and queue row, and that it ran
> `pnpm rules:catalog`.
>
> Also run `pnpm check && pnpm check-types` (the former does not typecheck) and
> report anything they flag that the PR did not fix.
>
> Tag findings `must-fix` / `follow-up` / `nit`. Write to
> `<campaign>/reviews/NN-rN-sweep.md`. Do not edit source.

## Wait for the three reports in the same turn

`claude -p` waits only 10 minutes after your last turn for background subagents.
Then it exits and kills them. The log line is `Background tasks still running 10m
after the last turn`. Two type-flow review rounds parked that way with no reports.

So start the three lanes and do not end your turn. Block in a foreground Bash call
until all three report files exist:

```bash
R="$C/reviews/NN-rN"
end=$(( $(date +%s) + 540 ))
until { [ -s "$R-up.md" ] && [ -s "$R-down.md" ] && [ -s "$R-sweep.md" ]; } || [ "$(date +%s)" -ge "$end" ]; do
  sleep 20
done
ls -l "$R"-*.md
```

One call stops after 9 minutes, under the 10-minute cap of the Bash tool. Run it
again until all three files exist, to a total of 45 minutes. Each call writes a
stream line, so the stale-output watchdog in `scripts/campaign.sh` does not kill a
healthy wait. At 45 minutes, write the names of the missing reports into the item
file, set `phase=needs-human`, and stop. Synthesize in the same turn as the wait.

## Synthesis

Read the three reports. Do not read the diff yourself — if the reports disagree
about what the code does, that is itself the finding, and one targeted read of the
disputed lines resolves it.

Then adjudicate, because three harsh reviewers over-produce:

- **Deduplicate.** The same defect seen from up and from down is one finding. Keep
  the framing that names the enforcement mechanism.
- **Demote anything that fails its gates.** An up-finding without a named
  de-risked change is aesthetics. A down-finding without a sequence is a worry.
  Both become `follow-up` at best.
- **Demote anything out of scope.** A pre-existing problem the diff merely
  _revealed_ is a new queue item, not a must-fix on this PR. This is the rule that
  decides whether the loop converges.
- **Honor a dispute.** If a previous round's finding was argued against in the item
  file, rule on the argument explicitly rather than re-raising the finding.
- **Cap it.** More than five must-fixes on one PR usually means the design was
  wrong, not the implementation. Say that instead, and send the item to
  `needs-human`.
- **Rank a false prose claim by its direction.** Prose is a PR body, a doc comment,
  or a doc. A claim that the code is safer or more closed than it is: `must-fix`,
  because a reader trusts it and skips a guard. A conservative misstatement, which
  predicts a worse outcome than the code gives: `nit`. `Preserved behavior` is the
  list of invariants, so an overclaim there is `must-fix` even when a later section
  corrects it. The general rule is in the Process section of
  [`review-checklist.md`](../../../docs/reference/review-checklist.md). This
  bullet only sets the severity.
- **Cite the line under each fix sentence.** When a must-fix prescribes text to
  paste, each fact in that text cites the `file:line` it rests on. Before you
  write the text into the round, read that line for each example the text names:
  each tool, field, case, or status. A fix sentence is a claim, and revise pastes
  it without a second check. Four type-flow items (05, 09, 43, 60) got a new false
  sentence from fix text that was wrong for one of its own examples. Keep
  an illustrative name that does not exist out of backticks: `check:doc-symbols`
  fails on it after the paste.

- **Name the smell of each code finding.** A must-fix or follow-up about code
  either matches a smell in
  [`docs/reference/smells/`](../../../docs/reference/smells/README.md) or is a new
  smell that can occur in another PR. Write it in the round's **Smells** list: the
  id, the `file:line`, and for a new smell the Bad lines from the diff and the Good
  lines from the fix. A one-off design finding is not a smell. Prose findings name
  `prose-not-safer-than-code` or another Process smell. The land phase records the
  list, so a smell that two PRs repeat becomes a gate decision, not a third finding.

Worked examples of the direction rule, from type-flow PRs:

| PR    | Sentence                                                                                                           | What the code does                                                                                              | Rank       |
| ----- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ---------- |
| #1528 | "A failed read-only MCP call through `mcp.call` now also fires the honesty note."                                  | A read-only failure returns `status:"tool_error"`, which logs `succeeded`. No note.                             | `must-fix` |
| #1528 | "So a failed read-only remote call stays silent."                                                                  | A remote error on a read with no reviewed policy becomes `status:"unknown"`, logs `failed`, and fires the note. | `nit`      |
| #1575 | Residual risk: only a run that is not terminal at deploy time can be affected.                                     | A model string that sanitizes to `""` can fail the new closure parse on any later run, not only in flight.      | `must-fix` |
| #1575 | "Each writer of a state field already validates against the owner schema before the write." (`Preserved behavior`) | `commitStepSuccess` sanitizes the state after the check, so the stored value can differ.                        | `must-fix` |
| #1575 | "No code parses the mentions against `parsedMentionSchema`."                                                       | The new closure parses them. The sentence states fewer checks than the code has.                                | `nit`      |
| #1539 | `LenientLeaf` doc: `check-types` catches a strict leaf on the id path.                                             | `.refine`, a transform arm, and strict object mode pass `check-types` and make the dedup key `null`.            | `must-fix` |
| #1539 | `LenientField` doc: "Each still nulls the dedup read."                                                             | A throw in a transform gives a 500, not a `null` key. The sentence claims no guard that the code lacks.         | `nit`      |

Before this rule, the synthesis rated the second #1528 row and the last #1539 row
`must-fix`. The first sent #1528 to `needs-human`. The second cost #1539 one more
review round.

Append to the item file's **Review** section:

```markdown
### Round N — <date>

**Verdict:** <clean | N must-fix | design-level concern>
**Down-conclusion:** <closed within scope | broken | unproven — residual risk: …>
**Ledger:** <recomputed, and whether it is negative>

**Must-fix**

1. `<file:line>` — <finding, one paragraph, naming the tier or the sequence>
   Fix text, if the fix is prose: <text to paste> (rests on `<file:line>`, …)

**Follow-up** (queued as items <ids>, not fixed here)

- …

**Won't-fix**

- <finding> — <the gate it fails>

**Smells**

- `<smell-id>` — `<file:line>`: <finding, one line>
- new `<kebab-id>` (<checklist section>) — `<file:line>`: <finding>
  Bad: <the lines from the diff> Good: <the lines of the fix>
```

Then close the phase as `PHASES.md` specifies. The raw subagent reports stay in
`reviews/` — nobody reads them again unless a verdict is challenged.
