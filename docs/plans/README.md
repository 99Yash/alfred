# docs/plans/

**Default: every file here is a historical snapshot.** A plan records what was
intended and decided at a point in time. It is not a description of current
behavior, and it was not updated when the code moved on.

Read a plan for its _reasoning_ — the constraints, the rejected shapes, the order
of attack. Never read one to learn how the system works today; for that, read the
code, or [`../reference/`](../reference/) for the conventions around it.

A plan overrides this default only by saying so in a `> **Status.**` block within
its first few lines. Anything without one has not been triaged and should be
assumed stale.

When a plan's work lands, the durable half of it belongs in
[`../../decisions.md`](../../decisions.md) (the decision and its alternatives) or
in [`../reference/`](../reference/) (the convention). The plan itself stays here
as a record; it does not get retrofitted.
