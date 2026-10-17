# docs/plans/

**Default: every file here is a historical snapshot.** A plan records what was
intended and decided at a point in time. It is not a description of current
behavior, and it was not updated when the code moved on.

Read a plan for its _reasoning_ — the constraints, the rejected shapes, the order
of attack. Never read one to learn how the system works today; for that, read the
code, or [`../reference/`](../reference/) for the conventions around it.

Every plan opens with front matter that says where its work stands. `status` is
one of `proposed`, `in-progress`, `done`, or `superseded`:

```yaml
---
status: in-progress
evidence: "PR 1 merged as #941; PRs 2 to 5 not built."
---
```

`pnpm check:plan-status` fails a plan without a valid `status:`. Set the status
from evidence (merged PRs, issue state, the code), never from the plan's own
prose, and update it in the PR that moves the work. The front matter wins over a
status line in the body: those lines are the record from when they were written.
A check cannot prove a status is still true, so treat a factual premise from a
plan as a claim to check before you build on it.

When a plan's work lands, the durable half of it belongs in
[`../../decisions.md`](../../decisions.md) (the decision and its alternatives) or
in [`../reference/`](../reference/) (the convention). The plan itself stays here
as a record; it does not get retrofitted.
