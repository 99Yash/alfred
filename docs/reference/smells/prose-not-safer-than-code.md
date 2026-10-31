---
id: prose-not-safer-than-code
section: Process
status: stays-review
rung: none
---

# Do not let prose claim that the code is safer or more closed than it is.

This applies to a PR body, a doc comment and a doc. A list that you call complete says why it is complete. A claimed closure names the sequences that you traced. A statement that predicts a worse outcome than the code is a smaller fault.

Why: a reader trusts the claim and does not do the check that it replaces. Example: a draft of #1458 gave three gaps in its liveness claim, and review found a fourth and a fifth. In #1459, a comment in `apps/web/src/lib/replicache/context.tsx` said that a pull sends no extra request, and a probe found one extra pull. That one comment took three review rounds.

## Bad

```text
Preserved behavior: each writer of a state field already validates against
the owner schema before the write.
```

The code: `commitStepSuccess` sanitizes the state after the check, so the stored value can differ (#1575).

## Good

```text
Preserved behavior: each writer validates against the owner schema.
commitStepSuccess sanitizes after the check, so the stored value can differ
from the checked value. The reader parse catches that case.
```

## Mechanism

A check cannot compare a claim with the sequences that the code permits. The campaign review ranks an overclaim `must-fix` and an underclaim `nit` (`.claude/skills/campaign/REVIEW.md`).

## Hits

- #1458 PR body: the liveness claim named three gaps; review found two more.
- #1459 `apps/web/src/lib/replicache/context.tsx`: a comment said a pull sends no extra request; a probe found one.
- #1528 PR body: "a failed read-only MCP call now also fires the honesty note"; the call logs `succeeded` and fires no note.
- #1575 Preserved behavior: "each writer already validates before the write"; `commitStepSuccess` sanitizes after the check.
- #1539 `LenientLeaf` doc: "`check-types` catches a strict leaf"; `.refine` and a transform arm pass `check-types`.
