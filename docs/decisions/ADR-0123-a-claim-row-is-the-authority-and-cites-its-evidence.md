# ADR-0123 — A claim row is the authority and cites its evidence; the observation log stays the activity record

**Status.** Proposed; not built. Decided with the owner on 2026-11-11. The full theory is [docs/theory/memory.md](../theory/memory.md). Reverses ADR-0067 for claims (claims and identity facts are no longer projections of the observation log). Amends ADR-0080 (identity claims are claim rows with evidence, not a projection), ADR-0111 (its rejected alternative (b) becomes the decision; claims are rows, and the reconciliation sweep is one capture path), and ADR-0056 and ADR-0019 (the model's confidence does not confirm a claim). Keeps ADR-0118 (the observation log is the record of what happened when).

**Decision in one paragraph.** A **claim** is one statement in memory, about the user or about a thing. A claim row is the authority for that statement. Each row links to its evidence in the raw record (a chat message, a mail, an activity event, an object-state fact, or a page snapshot), and no row exists without evidence. Each row records its **author** (the user said it, or the agent concluded it) and its **producer** (the pipeline, the deployed commit, and the model). Writers write claim rows directly. A new value supersedes the old row, and the history stays. A daily check job reads the evidence again, and it corrects or retires wrong rows. The user's correction wins at once. A user-asserted claim is the authority for its own time: the check can supersede it only with evidence dated after the user said it, and Alfred then tells the user. The observation log stays the record of what the user and each source did (ADR-0118). It is evidence for claims, not their authority.

## Why

- **The projection never wrote a claim.** ADR-0067, ADR-0080, and ADR-0111 make claims a projection of the observation log. In code the log has writers (Gmail, GitHub activity, affiliation, the standing-instruction audit), but no projection writes `user_facts`, and no reader reads claims from the log. The projection runner is not active in prod. Every correction and every instruction writes `user_facts` directly (`knowledge/facts.ts`, `knowledge/standing-instructions.ts`).
- **The design and the code disagree in ten places** (inventory of 2026-11-11). Examples: who writes a user correction, where chat claims go, and two significance scores. One authority removes the split.
- **A projection hides who made a claim.** A replayable fold over all events cannot tell "the user said it" from "a model inferred it" unless each event carries that label. The owner wants the author and the evidence on each claim, so that a check can read them and the user can see them.
- **A check needs a row to check.** The article that frames this theory ([The components of agent memory](https://www.anthropic.com/research/components-of-agent-memory)) fixes wrong notes with a pass that reads the raw record again. That pass needs a stable row with links to its evidence.

## What changes

- `user_facts` becomes the claim table in theory. A code change can rename it. Its source becomes a list of evidence links, an author, and a producer. The default author `{"kind":"agent"}` goes. The write time stops being the default start of validity.
- The 0.85 auto-confirm (`knowledge/facts.ts`) stops being the rule that confirms a claim. The read rule for unconfirmed claims is open (Q6 in the theory page).
- The ADR-0111 reconciliation sweep, chat capture, mail capture, and cold start are capture paths that write claim rows. ADR-0080's rule "no grounding, no row" stays as "no evidence, no row".
- `CONTEXT.md` widens **Claim** to every memory statement. **Fact** keeps its meaning from ADR-0122: a statement from the source that owns a thing.

## Alternatives

- **(a) Keep the projection and build it (ADR-0067 as written).** Rejected. It was designed in June 2026 and is still not active in prod. Every writer that touches memory today writes rows directly. A projection also needs an author label on each event to give the same result.
- **(b) Direct writes with no evidence link (the current `proposeFact` path).** Rejected. A wrong claim then has nothing that a check can read again. This is the "Weekday" employer fault of ADR-0080.
- **(c) A model confidence gate in place of evidence.** Rejected. The model's own confidence is not evidence (principle 5, ADR-0111 D2).

## Cross-ref

Theory: [docs/theory/memory.md](../theory/memory.md), which also settles name links, the turn-start lookup, chat capture, the check job, and the observability rows. The check job runs in Code Mode (ADR-0087) and waits for #535. Questions to the user use ADR-0099.
