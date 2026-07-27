# The review round

One review round = **three subagents in parallel**, then a synthesis you perform in
this context, then a verdict. The subagents do the reading; only their reports come
back. That is what keeps round 3 as cheap as round 1.

The governing document is [`docs/reference/structural-review.md`](../../../docs/reference/structural-review.md).
It is not summarized here — each brief tells its agent to read it. What is here is
the part that document leaves to the reviewer: how to run it *harshly*, and what
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
> Read `docs/reference/structural-review.md` in full, then run **only the up-pass**:
> passes 1, 2, and the up half of 5. Do not run the code-style sweep — another agent
> owns it.
>
> The change claims this invariant: `<invariant>`. Its stated vocabulary ledger is:
> `<ledger>`.
>
> Produce, in this order:
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
> Read `docs/reference/structural-review.md` in full, then run **only the
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
> Run the bounded surface sweep from `docs/reference/code-style.md` across the
> **authored** changed files. Classify first: authored sources get the sweep;
> generated artifacts (lockfiles, generated SQL, snapshots) get *reconciled* against
> their source and the intended delta — did generation emit only what was intended,
> is the resolution expected, is any operation destructive or reordered — and are
> never style-reviewed.
>
> Also run `pnpm check` and report anything it flags that the PR did not fix.
>
> Tag findings `must-fix` / `follow-up` / `nit`. Write to
> `<campaign>/reviews/NN-rN-sweep.md`. Do not edit source.

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
  *revealed* is a new queue item, not a must-fix on this PR. This is the rule that
  decides whether the loop converges.
- **Honor a dispute.** If a previous round's finding was argued against in the item
  file, rule on the argument explicitly rather than re-raising the finding.
- **Cap it.** More than five must-fixes on one PR usually means the design was
  wrong, not the implementation. Say that instead, and send the item to
  `needs-human`.

Append to the item file's **Review** section:

```markdown
### Round N — <date>

**Verdict:** <clean | N must-fix | design-level concern>
**Down-conclusion:** <closed within scope | broken | unproven — residual risk: …>
**Ledger:** <recomputed, and whether it is negative>

**Must-fix**
1. `<file:line>` — <finding, one paragraph, naming the tier or the sequence>

**Follow-up** (queued as items <ids>, not fixed here)
- …

**Won't-fix**
- <finding> — <the gate it fails>
```

Then close the phase as `PHASES.md` specifies. The raw subagent reports stay in
`reviews/` — nobody reads them again unless a verdict is challenged.
