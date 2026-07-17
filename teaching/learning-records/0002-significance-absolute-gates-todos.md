# Mission matured: significance is absolute & gates todos, not categories (issue #210)

The learner filed GitHub issue #210 — a prod-evidenced audit that advances the mission from "understand the flow" to a locked design direction. Demonstrated understanding well past Lesson 1: 26% of the inbox in demanding lanes, 1% todo acceptance, three named blind spots (category is significance-blind; significance is standing-blind; both are recurrence-blind), the governing asymmetry (**demote, never bury**), and an A/B/C plan (A=frame only, B=give significance a vote on category + standing-direction + recurrence decay, C=learn from dismiss:done as the north star). Recommendation: ship B's category-demotion decoupling first.

Why it steers future sessions: the design is now the learner's, not mine — teach to the *remaining unknowns* (exact code seams), never re-explain B back to them.

## Code verified (2026-06-20)
- Significance: `computeSignificance()` (`packages/api/src/modules/memory/significance.ts:76`), formula activity 0.5 / reciprocity 0.35 / sameOrg 0.15; stored at `entities.metadata.significance` (`packages/db/src/schema/memory.ts:210`).
- **Category-blindness proven in one comment:** `classify.ts:240` — "It does NOT change the category … it only gates the todo." Significance reaches the model *only* via `sender-relationship.ts:116` → todo rubric 16b.
- Standing data is **captured but unused**: cold-start extracts `job_title`/`company`/`team`/`location` into `user_facts` (`cold-start/extract.ts:30`); the cold-start *brief* (`memory_chunks` kind `cold_start_research`) is **write-only — read by nothing downstream**. Of the captured facts, only `job_title`+`company` are rendered (into sender-relationship), and even that votes on the todo, not the category.
- Building blocks for C already exist: `rejected_inferences` table (`memory.ts:374`); ADR-0060 standing instructions built for suppression; ADR-0055 eval lane scaffolded.

## Correction to Lesson 1
LR-0001 / Lesson 1 framed `senderRelationship` as purely sender/graph-derived and contributing "nothing" for cold contacts. More precise: it *also* carries the user's own `job_title`+`company` — so a thin slice of user standing is already in the prompt, just (a) on the todo path only and (b) not used for category. The fix is therefore less "add a brand-new field" and more "give an already-present signal a category vote." Also corrected: standing should be **derived, not declared** (issue's option A is framing only).
