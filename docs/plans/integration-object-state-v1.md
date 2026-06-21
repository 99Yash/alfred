# Integration object-state memory — v1 vertical slice (#212, ADR-0062)

Tier 1 of epic #218. Implements ADR-0062 for the **GitHub PR / CI** case only; resolves the "merged PR shows failing for days" briefing loop. Honors ADR-0048 (`absence never closes`).

**Prereq:** PR 220 (#211 self-ingestion) must land + the prod backfill must run first — the prod corpus still has Alfred's own "build still failing" self-emails that would be matched as phantom loops.

## Scope (in)

- `integration_objects`, `integration_object_keys`, `integration_object_relations` tables (`db:generate` → `db:migrate`, never `db:push`).
- Registry in `@alfred/contracts`: `IntegrationObjectDef` + the `github` entry (`as const satisfies`). `StateCategory = active|resolved|failed|abandoned`.
- GitHub reducer in `@alfred/api`: `applyEvent` folding `pull_request` (opened/synchronize/closed+merged) and `check_suite` deliveries into object-state + keys. Runs **on webhook delivery** (hook into `github-webhook.ts`) **and** a backfill over existing `webhook_events`.
- `ObjectStateStore` interface: `applyEvent`, `resolveByKey`, `getState`, `related`, `list`.
- v1 deterministic `extractKeys(document)` — GitHub-CI regex pulling `head_sha` (the boss-driven version is ADR-0063, later).
- Briefing reconciliation in `gather.ts`: per CI-failure email loop → `extractKeys` → `resolveByKey` → `getState`; `resolved/abandoned` ⇒ drop from demanding lane + evening "closed today" recap; unknown ⇒ stays live.
- **Contract test:** closure only on positive `resolved`; missing state ⇒ live. Required before merge.

## Scope (out / parked)

- Recurrence-decay (#212 "B", demote-never-bury) — separate ticket.
- ClickUp / remote-Claude-Code reducers — land with those integrations.
- Boss chat-tool exposure of `getState`/`resolveByKey` (interface ready; wiring is fast-follow).
- The rich extraction front-door — ADR-0063 (own grill).

## Proven matching chain (prod recon, 2026-06-21)

CI-failure email (`notifications@github.com`) carries repo + `head_sha`, **no PR number**. Chain: email `head_sha` → `pull_request` opened/synchronize webhook with matching `head.sha` → PR# → `pull_request.closed merged=true` → `resolved`. Verified end-to-end on PR#172. This spans the PR's whole event history → forces the materialized projection (a 24h gather recompute can't see it).

## Build order

1. Schema + migration.
2. Registry (`@alfred/contracts`) — github entry, types, normalize.
3. GitHub reducer + backfill (replay existing `webhook_events`).
4. Wire reducer into `github-webhook.ts` delivery path (real-time).
5. `ObjectStateStore` impl over the new tables.
6. `extractKeys` (deterministic github-CI regex) + briefing reconciliation in `gather.ts`.
7. Contract test (`absence never closes`).
8. Verify against prod webhook_events backfill.

## Open (from the grill)

- Backfill horizon over `webhook_events`.
- `check_suite` as its own kind vs a PR attribute.
- Cross-source dedup convergence policy (ADR-0052(B)'s binding constraint) — not exercised until a 2nd provider.
