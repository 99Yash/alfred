# Alfred email triage — Resources

The "trusted sources" for this topic are the codebase itself and its ADRs. No external theory.

## Knowledge (code — the source of truth)

- `packages/api/src/modules/triage/classify.ts`
  The classifier. `classifyEmail()` (737–801), `SYSTEM_PROMPT` (221–324), `userPrompt()` (385–435), `detectConflict()` (463–498), `applyOverrideFloor()` (505–528). Use for: how a tag is actually decided.
- `packages/api/src/modules/triage/observations.ts`
  Deterministic context assembled before the model. `Observations` interface (137–157). Use for: what hints the model gets — and where senderRelationship lives (ADR-0059).
- `packages/api/src/modules/triage/sender-context.ts`
  Pure header/body parsing → fromKind, effectiveAuthor, botSlug (ADR-0042). Use for: how "who sent this" is derived for free.
- `apps/server/src/builtins/workflows/email-triage.ts`
  The orchestration. `gatherObservations()` (258–273), classify step (133–503), apply-label step (506–569), todo tail (383–464). Use for: the end-to-end flow.
- `packages/db/src/schema/triage.ts`
  `email_triage` table, thread-keyed PK (25–74). Use for: the triage unit's shape.
- `packages/contracts/src/triage.ts`
  `TRIAGE_CATEGORIES` taxonomy + display (12–44). Use for: the output vocabulary.
- `docs/reference/triage.md`
  Narrative reference. Use for: the prose overview.

## The audit (the mission, in one doc)

- **GitHub issue #210** — "Product: triage over-tags attention — significance is absolute & gates todos not categories." `gh issue view 210`. Prod evidence + root-cause decomposition + the A/B/C direction. This is the spec; an ADR follows once B is detailed.

## Knowledge (the standing/significance machinery — verified 2026-06-20)

- `packages/api/src/modules/memory/significance.ts:76` — `computeSignificance()`; formula activity 0.5 / reciprocity 0.35 / sameOrg 0.15. Where the absolute score is born.
- `packages/db/src/schema/memory.ts:210` — significance stored at `entities.metadata.significance`. Also: `user_facts` (58), `memory_chunks` cold_start_research (289), `rejected_inferences` (374).
- `packages/api/src/modules/triage/sender-relationship.ts:82` — `resolveSenderRelationship()`; the ONE place significance + user job_title/company reach the prompt — and it gates the todo only.
- `packages/api/src/modules/triage/classify.ts:240` — the comment that proves it: "It does NOT change the category … it only gates the todo." The line your ADR has to change.
- `packages/api/src/modules/cold-start/extract.ts:30` — captures job_title/company/team/location into `user_facts`. The cold-start *brief* itself (`memory_chunks`) is write-only — read by nothing downstream.

## Knowledge (ADRs — the decisions)

- `decisions.md` — read these entries:
  - ADR-0025 — core triage architecture.
  - ADR-0042 — deterministic SenderContext parser.
  - ADR-0050 — todo-worthiness rubric (the 5 ordered tests).
  - ADR-0051 — Triage v3: cheap-model-always + deterministic context.
  - ADR-0059 — sender relationship descriptor (significance + reciprocity + org + role).
- Memory: `project_user_context_consumption_map.md`
  Records that boss/triage/briefing read NO facts/bio/memory and cold_start brief is reachable only via skill-documentation recall. This is the documented form of the gap.

## Wisdom (communities)
- Not applicable yet — this is a closed single-user system. The "community" here is the design-review loop (warden, ADR review). Revisit if you want external triage-design critique.

## Gaps
- ~~How the cold-start brief is structured~~ — RESOLVED: brief is `memory_chunks` prose (write-only); structured standing lives in `user_facts` (job_title/company/team/location). Team+location captured but never rendered.
- Open: the **standing-direction** signal (B2) has no implementation yet — sender title from signature/domain, recruiter/job-seeker patterns. Next research target if B advances.
- Open: **recurrence decay** (B3) — no mechanism today re-escalates a repeating no-reply sender independently each time (CloudWatch/ClickUp). Design needed.
