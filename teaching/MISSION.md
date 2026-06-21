# Mission: Alfred email triage — the "user standing" gap

## Why
You're doing staff-level design on a real defect (now filed as **issue #210**): Alfred's triage over-tags *attention* — 26% of the inbox lands in demanding lanes, todo acceptance is ~1%. Root cause is structural, not rubric tuning: the **category** decision is significance-blind, and the significance signal it does have is **absolute (standing-blind) and only gates the todo, never the category**. The canonical failure: a LinkedIn `awaiting_reply` from a cold junior job-seeker wears a demanding badge.

Direction is now **locked** (issue #210): governing constraint is **demote, never bury** (asymmetric risk). Ship **B first** — decouple so significance can demote the *category* (not just the todo), enrich it with a standing-direction signal + recurrence decay. **A** (model the user's standing) is framing only — standing is **derived, not declared**. **C** (learn from the user's dismiss:done behavior) is the north star.

## Success looks like
- You can name every component in the triage pipeline and trace one email end-to-end from memory.
- You can point to the exact line proving category is significance-blind (`classify.ts:240`) and name the standing data already captured but unused (`user_facts` job_title/company/team; the write-only cold-start brief).
- You can write the ADR for B: where the category-demotion hook plugs in (mirroring `applyOverrideFloor()`), governed by demote-never-bury.

## Constraints
- You are an expert engineer who built most of this — teach dense and precise, not from zero.
- Ground every claim in this repo's actual code (file:line), not generic email-triage theory.
- Topic is bounded to the triage subsystem and its inputs; not the whole agent.

## Out of scope (for now)
- Reworking ingestion / Gmail watch / pub-sub plumbing.
- The boss agent, briefing, and chat surfaces, except where they share the user-context-consumption gap.
- Replicache sync mechanics.
