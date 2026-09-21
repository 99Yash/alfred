# ADR-0106 — A sender suppression reaches the triage category as a prior, not a floor

**Decision.** Register a fourth suppression effect, `deprioritize_triage_category`, and render the matched instruction's `phrasing` into the triage `Observations` block — first, above every derived signal — so the cheap model weighs the user's own words when it picks the Gmail label. This implements ADR-0066 signal 3 (standing instructions extended to the category). The rendering follows ADR-0051 §5's anti-brittleness line: a deterministic fact fed as a hint, never a rewrite.

**Prior, not floor.** The stored directives say routine notices are low priority AND that a genuinely urgent one may still surface. Only a model can separate those two, so no deterministic demotion survives: the handling rule beside the phrasing uses prior language ("treat as a prior", "prefer", "allowing"), never an exclusive condition. The protective security floor still outranks a user down-rank.

**Placement is load-bearing.** A first version put the handling rule in `SYSTEM_PROMPT`, where it reached every email including ones with no instruction; a paired eval run moved four unrelated rows (`clickup-bot-done-buries-live` flipped `action_needed` → `fyi`). The rule now ships inside the conditional branch, scoped to the matched sender, so mail with no instruction sees a byte-identical prompt.

**Derived membership, no repair.** Writers store the full registry (`effects: [...SUPPRESSION_EFFECTS]`) and no writer ever picks a subset, so the stored array encodes the registry length at write time, never a decision. Membership is therefore derived at read time: any active suppression binds its sender for every consumer. There is no adopt repair, no backfill, and no stale-row state — a fifth effect reads the same rows with no widening. The stored array is stamped for schema compat only and is never branched on.

**Trace distinguishes two nulls.** `standingInstructionCategoryFactId = null` is ambiguous alone, so the trace carries one flag: `standingInstructionCategoryReadFailed` ("unknown"). False means "no instruction". A fact id beside a demand lane is the model declining the prior, not a missing read.

**Phrasing, not directive.** The rendered line is the verbatim `phrasing`, not the resolved `directive`: `directive` is the model-composed, prompt-ready sentence from capture time, so ordering on it would rest the "cannot be wrong" claim on Alfred's own inference. Only the user's own words outrank derived signals on what the user wants.

**Stated consequence.** Every instruction written from today carries label control with no per-effect user choice; the `system.remember` tool description discloses the category prior so the capture path states it. Per-address scope is unchanged — a registrar the user has not heard from stays uncovered (#1107).

**Related.** #1107 (domain/organization targets) is the other half: this ADR widens what a matched instruction can do, not who matches.
