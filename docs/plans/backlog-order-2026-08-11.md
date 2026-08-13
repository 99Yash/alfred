# Backlog order, 2026-08-11

> **Status.** Live. This file supersedes
> [`backlog-order-2026-07-30.md`](./backlog-order-2026-07-30.md). Do not edit
> the old order in place; it remains the record of the state and reasoning on
> 2026-07-30.
>
> **Verified against:** `main` at `f48b4609`, the open GitHub issue set, and
> the accepted ownership split in ADR-0089. The architecture check is green at
> 58 package edges and 72 assistant-module edges. A green check means the
> current ratchets hold; it does not mean the package extraction is complete.

## What changed since the previous order

The product sequence in the old order remains useful, but its implementation
units do not. Alfred now separates these owners:

- `@alfred/assistant` owns product behavior;
- `@alfred/http` owns transport adapters;
- `apps/server` owns process composition; and
- legacy `@alfred/api` is temporary and must be deleted at the end of Phase 6.

Phases 0–5 of the agent-friendly module migration are complete. Phase 6 is in
progress. The assistant and HTTP packages exist, but `@alfred/api` still owns
about 20,700 lines of source, including dispatch, tool registration, MCP,
Replicache, and transitional composition. Backlog work that changes those
surfaces must either be small enough to survive a move unchanged or wait until
the owner is stable.

This changes the start point in two ways:

1. One small outbound-safety issue is still real and can move now.
2. The next large workflow issue is still correct as a product requirement, but
   it must be split by the new module owners before implementation.

## Tier 0 — close the Calendar invite hole

Start **#232**.

The verified behavior is unchanged:

- `calendar.create_event` has a static `riskTier: "medium"`;
- a non-empty `attendees` list makes the Google adapter set
  `sendUpdates=all`;
- the autonomy floor forces approval only for `high` risk; and
- therefore an autonomous Calendar policy can send invitations without human
  approval.

The implementation is narrow:

1. Resolve `calendar.create_event` as `high` when validated input has one or
   more attendees.
2. Keep an event without attendees at `medium`.
3. Prove both inputs under an autonomy policy.
4. Prove the staged approval retains the full attendee list.

Do not add a second general approval mechanism. The existing high-risk floor is
the owner of this invariant.

## Tier 1 — finish the package extraction

After #232, finish ADR-0089 Phase 6 before starting the workflow effect work.

The completion condition is the one in
[`agent-friendly-module-structure.md`](./agent-friendly-module-structure.md):

- `@alfred/http` contains transport adapters only;
- `@alfred/assistant` does not import transport;
- the web app imports only the `App` type from `@alfred/http`; and
- legacy `@alfred/api` is deleted.

Do not call Phase 6 complete because the architecture check is green. The
baseline permits named transitional debt to shrink without permitting new debt.
The package deletion is the completion test.

Phase 7 remains after extraction: close public surfaces, enforce table-write
ownership, remove the remaining web feature doors, and update stale path
documentation.

## Tier 2 — resume workflows v1, with new slices

The semantic order remains:

```text
#559 -> #560 -> #561
```

Do not implement **#559** as one change. It now spans three deep modules plus
the DB boundary. Replace it with these slices while keeping #559 as the parent:

### #559a — effect identity and outcome ledger

**Owner:** `@alfred/assistant/tool-runtime` with the schema in `@alfred/db`.

- Add a logical effect key that survives attempt reclaim.
- Keep attempt identity separate.
- Bind a canonical request hash and provider idempotency key where supported.
- Represent `planned`, `awaiting_approval`, `dispatching`, `succeeded`,
  `failed`, `unknown`, and `compensated` without adding a competing write
  ledger.
- Prevent a fresh model tool-call id from bypassing an unresolved ambiguous
  effect.

### #559b — cancellation generation and fences

**Owner:** `@alfred/assistant/execution`.

- Add a cancellation generation or equivalent monotonic fence.
- Reject a stale step commit after cancellation.
- Recheck the fence immediately before an external effect dispatch.
- Reject pending approvals on cancellation without erasing effects that already
  completed or became unknown.

The tool runtime must consume a bounded execution fence contract. It must not
import execution implementation files.

### #559c — unattended workflow retry contract

**Owner:** `@alfred/assistant/automation`, tested through the public execution
and tool-runtime interfaces.

- A reclaimed attempt keeps the same logical effect identity.
- A possibly delivered, non-idempotent write becomes `unknown` and does not
  retry automatically.
- Approval resume revalidates mutable state or asks again.
- “Retry step” keeps the run, revision, occurrence, and effect identities;
  “Run again” creates a new occurrence.

Close #559 only when all three slices and the cross-module acceptance cases are
complete.

### #560 — subtract the readiness work that already exists

Do not restart #560 from its original issue body. The current code already has:

- Gmail watch expiry checks;
- receiver and topic configuration checks;
- a usable `historyId` cursor check;
- coverage-gap and stale-sync checks; and
- workflow activation readiness that reports `trigger_not_ready` or
  `provider_unhealthy`.

The remaining work is the durable control-plane residue:

- persist Gmail Pub/Sub receipts by provider delivery identity;
- make receipt processing status and verification auditable;
- give subscription/watch state one explicit application owner instead of
  relying only on credential metadata;
- make renewal and coverage-gap transitions visible to workflow status; and
- prove duplicate receipts create at most one occurrence.

Keep provider cursor semantics provider-specific. Do not create one fake generic
cursor abstraction for Gmail, Calendar, and GitHub.

### #561 — real outcomes and workflow history

Keep #561 last. The web History tab still labels its rows `Preview data`, and
the Approvals tab is static policy prose. Build them only after #559 supplies
stable effect receipts and typed outcomes and #560 supplies truthful trigger
health.

## Tier 3 — one safe product slice beside the migration

**#573** is the safe parallel product item.

The triage prompt now has a stable product owner at
`@alfred/assistant/triage`. Its eval imports the assistant module rather than a
deleted API-private path. The prompt is still 42,085 characters, approximately
10.5k tokens, so the original cost and latency concern remains.

Work it as measured slices:

1. Record the current eval and replay baselines.
2. Measure prompt size by section.
3. Remove repeated examples before removing governing rules.
4. Run the eval after each section change so a regression has one cause.
5. Stop when further compression trades classification or todo precision for
   token count.

Do not make #573 part of the package extraction. It is product behavior and can
merge independently when its eval gate holds.

## Reconcile before build

These old-order items are not ready to implement from their current issue
bodies:

| Item            | Current ruling                                                                                                                                                                                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#210**        | The presentation-layer attention scorer is built. Run the production verification named in the issue, then close or file the precise residual. Do not rebuild the category-demotion proposal that the later ADR rejected.                                                     |
| **#353 / #354** | Tracker-owned, cold-sender, and monitoring-alarm suppression work has landed, and the alarm acceptance query passed. Re-audit the current todo rail and re-scope the remaining user-model gap from current failures.                                                          |
| **#478**        | The standard route still uses medium reasoning, but AI SDK 7 changed the provider-mechanics owner. Repeat the low-vs-medium live measurement before designing a per-turn router against the new route interface.                                                              |
| **#547**        | OAuth, persistence, connection routes, and part of the broker landed. The endpoint authorizer still states that full SSRF and rebinding protection are deferred. Re-scope the real-server, trust-nonce, downgrade-write, and SSRF residue after the connection move finishes. |
| **#570**        | API, HTTP, web, and sync now have checked test projects, while other test trees and moved tests differ from the issue's 201-file snapshot. Recount after Phase 6 and rewrite the issue from the programs CI actually runs.                                                    |

## Items that remain closed or complete

Do not reopen the completed Tier 0 work from the old order:

- #453 OAuth credential vault encryption and rollout;
- #455 Better Auth security floor;
- #457 Gmail webhook configuration, closed as a duplicate;
- #533 outbox retention; and
- workflow slices #555 through #558.

The authored-workflow epic #553 stays open until #559, #560, and #561 close.
The composable automation epic #554 remains downstream of that completion.

## Live queue

```text
1. #232 — Calendar attendee-dependent high-risk floor
2. Finish ADR-0089 Phase 6 and delete @alfred/api
3. Re-slice and build #559a -> #559b -> #559c
4. Build the reduced #560 residue
5. Build #561 outcomes + real History/Approvals
```

Run **#573** beside items 1–2 when a second product lane is available.

Reconcile #210, #353/#354, #478, #547, and #570 from current evidence before
putting any of them back into the implementation queue.
