# Alfred docs map

Use this file first. It says what is current, what is historical, and where to
edit next.

## Read order

| Need | Read |
| --- | --- |
| Setup / commands | [`../README.md`](../README.md) |
| Current repo shape | [`reference/architecture.md`](./reference/architecture.md) |
| Code rules before edit/review | [`reference/code-style.md`](./reference/code-style.md) |
| Non-obvious decisions | [`../decisions.md`](../decisions.md) |
| Domain vocabulary | [`../CONTEXT.md`](../CONTEXT.md) |
| Current milestone state | [`reference/milestones.md`](./reference/milestones.md) |
| Ops scripts / smokes / backfills | [`reference/operations.md`](./reference/operations.md) |

## Docs lifecycle

| Area | Meaning | Current home |
| --- | --- | --- |
| Reference | Shipped behavior and runbooks. Keep current with code. | [`reference/`](./reference/) |
| Plans | Build specs, grills, handoffs. May be active, shipped, or superseded. Check status at top before using. | [`plans/`](./plans/) |
| ADRs | Decision log. Authoritative for why choices exist, including rejected options. One file per ADR; `decisions.md` is the snapshot + index. | [`decisions/`](./decisions/), [`../decisions.md`](../decisions.md) |
| Vocabulary | Load-bearing terms used by code/plans/ADRs. The single home — definition plus the non-obvious why, never restated implementation. Update when a term's meaning changes. | [`../CONTEXT.md`](../CONTEXT.md) |
| Blogs | Narrative writeups. Not source of truth. | [`blogs/`](./blogs/) |

## Active maps

| Domain | Code | Reference | Plans |
| --- | --- | --- | --- |
| Agent runtime / chat | `packages/assistant/src/execution`, `packages/assistant/src/chat`, `packages/http/src/agent.ts`, `apps/web/src/routes/-chat` | [`reference/elysia.md`](./reference/elysia.md), [`reference/ai-sdk.md`](./reference/ai-sdk.md) | [`plans/artifact-sidebar-v1.md`](./plans/artifact-sidebar-v1.md), [`plans/chat-file-uploads-v1.md`](./plans/chat-file-uploads-v1.md), [`plans/model-router-v1.md`](./plans/model-router-v1.md) |
| Artifacts | `packages/artifacts-design`, `packages/assistant/src/artifacts`, `apps/web/src/routes/-chat` | [`reference/architecture.md`](./reference/architecture.md) | [`plans/artifact-sidebar-v1.md`](./plans/artifact-sidebar-v1.md) |
| Email triage | `packages/assistant/src/triage`, `packages/assistant/src/connections/ingestion`, `packages/integrations/src/google` | [`reference/triage.md`](./reference/triage.md) | [`plans/triage-v3-plan.md`](./plans/triage-v3-plan.md), [`plans/triage-user-model-v1.md`](./plans/triage-user-model-v1.md) |
| Briefing | `packages/assistant/src/briefings`, `apps/web/src/routes/-briefings` | [`reference/briefing.md`](./reference/briefing.md) | [`plans/daily-briefing-cutover-plan.md`](./plans/daily-briefing-cutover-plan.md) |
| Memory / user model | `packages/assistant/src/knowledge`, `packages/contracts/src/user-model.ts`, `packages/db/src/schema/user-model.ts` | [`reference/user-model-gmail-projection-activation.md`](./reference/user-model-gmail-projection-activation.md) | [`plans/multi-source-user-model-v1.md`](./plans/multi-source-user-model-v1.md), [`plans/user-model-p1-gmail-shadow.md`](./plans/user-model-p1-gmail-shadow.md), [`plans/identity-facts-projection-v1.md`](./plans/identity-facts-projection-v1.md), [`plans/memory-capture-hardening.md`](./plans/memory-capture-hardening.md) |
| Integrations / tools | `packages/integrations`, `packages/assistant/src/tool-runtime` | [`reference/architecture.md`](./reference/architecture.md), [`reference/auth.md`](./reference/auth.md), [`reference/tool-runtime-map.md`](./reference/tool-runtime-map.md) | [`plans/integration-loading-v2.md`](./plans/integration-loading-v2.md), [`plans/integration-object-state-v1.md`](./plans/integration-object-state-v1.md), [`plans/tool-robustness-and-honest-surfaces-v1.md`](./plans/tool-robustness-and-honest-surfaces-v1.md) |
| Sync / web | `packages/sync`, `packages/http/src/sync`, `apps/web/src` | [`reference/replicache.md`](./reference/replicache.md), [`reference/architecture.md`](./reference/architecture.md) | [`plans/write-surface-plan.md`](./plans/write-surface-plan.md), [`plans/security-hardening-286.md`](./plans/security-hardening-286.md) |

## Maintenance rules

- New shipped behavior -> update `reference/`.
- New design decision -> add `decisions/ADR-NNNN-<slug>.md` and a row in `decisions.md`'s index; add/adjust vocabulary when needed.
- New build plan -> put `Status:` near top: `active`, `built`, `superseded`, or `parked`.
- Completed plan with durable value -> either fold into `reference/` or mark `Status: built`.
- Do not use `plans/` as current truth unless its status says active.
- Code moved -> repoint the path a reader must follow **today**. `reference/` docs, `runbooks/`, this file, and an accepted ADR describe the current system, so a dead path in one of them is a defect. Leave the path in `plans/`, `research/`, `blogs/`, `roadmap.md`, `rfc-triage-tags.md`, and a superseded ADR: each of those records what was true on its own date, and if you repoint one row of a table whose other rows are equally dead, the doc looks current when it is not. An ADR is accepted unless `decisions.md`'s index records it as superseded; a supersession scoped to a fragment applies only to that fragment. Three clauses close the rule, so no sweep decides a file by hand:
  - **Any doc the two lists above do not name:** if the doc does not describe the system as it is today, leave the path.
  - **A target is not a dead reference.** A path that names the **intended** layout, such as a target tree in an active plan or in `roadmap.md`, stays as written. It becomes correct when the work lands. Where a target description and the accepted-ADR rule both fire on one file, the target description wins.
  - **A blocked reader gets a pointer, not an edit.** Add a dated pointer beside the dead path. Do not change the path itself.
