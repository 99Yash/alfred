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
| Domain vocabulary | [`../CONTEXT.md`](../CONTEXT.md), [`reference/glossary.md`](./reference/glossary.md) |
| Current milestone state | [`reference/milestones.md`](./reference/milestones.md) |
| Ops scripts / smokes / backfills | [`reference/operations.md`](./reference/operations.md) |

## Docs lifecycle

| Area | Meaning | Current home |
| --- | --- | --- |
| Reference | Shipped behavior and runbooks. Keep current with code. | [`reference/`](./reference/) |
| Plans | Build specs, grills, handoffs. May be active, shipped, or superseded. Check status at top before using. | [`plans/`](./plans/) |
| ADRs | Decision log. Authoritative for why choices exist, including rejected options. | [`../decisions.md`](../decisions.md) |
| Vocabulary | Load-bearing terms used by code/plans/ADRs. Update when term meaning changes. | [`../CONTEXT.md`](../CONTEXT.md), [`reference/glossary.md`](./reference/glossary.md) |
| Blogs | Narrative writeups. Not source of truth. | [`blogs/`](./blogs/) |

## Active maps

| Domain | Code | Reference | Plans |
| --- | --- | --- | --- |
| Agent runtime / chat | `packages/api/src/modules/agent`, `packages/api/src/modules/chat`, `apps/web/src/routes/-chat` | [`reference/elysia.md`](./reference/elysia.md), [`reference/ai-sdk.md`](./reference/ai-sdk.md) | [`plans/artifact-sidebar-v1.md`](./plans/artifact-sidebar-v1.md), [`plans/chat-file-uploads-v1.md`](./plans/chat-file-uploads-v1.md), [`plans/model-router-v1.md`](./plans/model-router-v1.md) |
| Email triage | `packages/api/src/modules/triage`, `packages/api/src/modules/integrations`, `packages/integrations/src/google` | [`reference/triage.md`](./reference/triage.md) | [`plans/triage-v3-plan.md`](./plans/triage-v3-plan.md), [`plans/triage-user-model-v1.md`](./plans/triage-user-model-v1.md) |
| Briefing | `packages/api/src/modules/briefing`, `apps/web/src/routes/-preview-briefings` | [`reference/briefing.md`](./reference/briefing.md) | [`plans/daily-briefing-cutover-plan.md`](./plans/daily-briefing-cutover-plan.md) |
| Memory / user model | `packages/api/src/modules/memory`, `packages/api/src/modules/user-model`, `packages/contracts/src/user-model.ts`, `packages/db/src/schema/user-model.ts` | [`reference/user-model-gmail-projection-activation.md`](./reference/user-model-gmail-projection-activation.md), [`reference/glossary.md`](./reference/glossary.md) | [`plans/multi-source-user-model-v1.md`](./plans/multi-source-user-model-v1.md), [`plans/user-model-p1-gmail-shadow.md`](./plans/user-model-p1-gmail-shadow.md), [`plans/identity-facts-projection-v1.md`](./plans/identity-facts-projection-v1.md), [`plans/memory-capture-hardening.md`](./plans/memory-capture-hardening.md) |
| Integrations / tools | `packages/integrations`, `packages/api/src/modules/tools`, `packages/api/src/modules/dispatch` | [`reference/architecture.md`](./reference/architecture.md), [`reference/auth.md`](./reference/auth.md) | [`plans/integration-loading-v2.md`](./plans/integration-loading-v2.md), [`plans/integration-object-state-v1.md`](./plans/integration-object-state-v1.md), [`plans/tool-robustness-and-honest-surfaces-v1.md`](./plans/tool-robustness-and-honest-surfaces-v1.md) |
| Sync / web | `packages/sync`, `packages/api/src/modules/replicache`, `apps/web/src` | [`reference/replicache.md`](./reference/replicache.md), [`reference/architecture.md`](./reference/architecture.md) | [`plans/write-surface-plan.md`](./plans/write-surface-plan.md), [`plans/security-hardening-286.md`](./plans/security-hardening-286.md) |

## Maintenance rules

- New shipped behavior -> update `reference/`.
- New design decision -> update `decisions.md`; add/adjust vocabulary when needed.
- New build plan -> put `Status:` near top: `active`, `built`, `superseded`, or `parked`.
- Completed plan with durable value -> either fold into `reference/` or mark `Status: built`.
- Do not use `plans/` as current truth unless its status says active.
