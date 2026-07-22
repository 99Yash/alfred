# User-Authored Workflows v1 — chat-authored, interpreted, revisioned, capability-gated

**Status:** PRD / researched draft · **Date:** 2026-07-22  
**ADR:** implements the user-authored half of **ADR-0017** (workflows = `trigger + brief + optional DAG`) and **ADR-0025** (user-authored workflows alongside builtins). Reuses ADR-0027 (trigger dispatch), ADR-0040 (brief-only executor), ADR-0043 (`allowed_integrations` write ceiling), ADR-0047 (event bus), ADR-0053 (connected-tool grounding), ADR-0069 (`high`-risk always-confirm floor), and ADR-0071 #6 (result honesty). **Epic:** needs a GitHub issue.  
**Research:** [synthesis](../research/workflows-v1-research-synthesis.md), [product/authoring UX](../research/workflows-v1-product-authoring-ux.md), [runtime semantics](../research/workflows-v1-runtime-semantics.md), [integration/event lifecycle](../research/workflows-v1-integration-event-lifecycle.md).

---

## Problem Statement

Alfred can run workflows but a user cannot author one. The shipped spine is substantial:

- `Workflow<S>` is a named-step state machine (`packages/api/src/modules/agent/types.ts`).
- `workflows` already models `trigger + brief + optional steps DAG` (`packages/db/src/schema/workflows.ts`).
- `workflows.tick` dispatches cron occurrences, `emitEvent` dispatches supported events, and `userAuthoredBriefWorkflow` executes a free-text brief through the durable boss/tool loop.
- Dispatcher policy already enforces connected-tool availability, run-local active-tool membership, the workflow's integration ceiling, and per-effect approval.

The authoring surface is an explicit stub. The web button says “Author a workflow from chat; full create flow lands next”; `workflowUpdate` can mutate an existing user row, but no create flow exists.

The missing feature is not merely an insert. Unattended behavior needs four product guarantees:

1. **Preserve intent.** Missing setup must not make the user repeat the workflow after an OAuth detour.
2. **Approve an exact contract.** A user must see the concrete trigger, account/resource scope, allowed tools, assumptions, and external effects before activation.
3. **Run only a pinned definition.** Edits, retries, approvals, and deploys must remain attributable to the revision that created the run.
4. **Fail honestly and recoverably.** Disconnection, dead event subscriptions, duplicate delivery, ambiguous writes, and cancellation must not become silent degradation or misleading “nothing happened” reports.

## Product Decision

Ship a **chat-authored, interpreted, brief-only workflow** with two distinct operations:

1. `system.author_workflow` saves or revises an internal **draft**, validates its concrete capability and trigger contract, and returns readiness blockers. Saving a draft is not activation and has no unattended external effect.
2. `system.activate_workflow` is `high` risk. It binds to one immutable revision/hash, revalidates readiness, shows the activation approval card, and publishes that revision for future occurrences.

This separation is load-bearing. The dispatcher stages a `high`-risk tool before its `execute` body runs; therefore one high-risk `author_workflow` tool cannot first execute a custom resolver and then decide what approval card to show. Draft first, activate second fits the existing dispatch boundary and the correct product lifecycle.

The execution body remains interpreted: each occurrence runs the approved brief through `userAuthoredBriefWorkflow`. V1 does **not** require a DAG interpreter, generated persistent code, a sandbox, a generic content mirror, or a vector index.

The runtime is reused but not unchanged. V1 adds immutable definition revisions, durable occurrence/effect identity, readiness guards, cancellation fencing, and typed run outcomes because those are correctness prerequisites for unattended execution.

### Forks decided

1. **Execution mode → interpreted-only.** Low-frequency and judgment-heavy workflows use the existing boss loop. Compilation is a measured later graduation, not a v1 prerequisite.
2. **Authoring surface → chat proposal plus activation card.** No dedicated wizard. The disabled Create button can later open chat with an authoring affordance and reuse the same server services.
3. **Missing integration → blocked draft, never half-active.** Preserve the exact proposal and setup actions, but do not publish a runnable revision until all required capabilities and the trigger are ready.
4. **Capability unit → exact tool/account/resource contract.** Integration slugs remain the coarse security ceiling; they are not evidence that the intended action is executable.
5. **Edits → immutable revisions.** Active behavior remains pinned to the published revision until a validated new revision is explicitly activated.
6. **Event health → readiness outside the run.** Pre-run credential checks do not detect expired watches or disabled webhooks; subscription, delivery, and recovery-cursor health are separate.
7. **Compilation threshold → measured stability, not frequency alone.** Require meaningful volume, low trajectory entropy, stable schemas, safe idempotency/reconciliation, fixtures, and a measured cost/latency win.

## User Experience

### Happy path

1. The user says, “Every weekday before standup, brief me on what merged and what is still blocked.”
2. The boss resolves a concrete proposal:
   - weekday schedule and IANA timezone;
   - next expected run;
   - verbatim brief plus a short intent outline;
   - exact tools, selected accounts, and resource boundaries;
   - whether any external writes may be proposed;
   - assumptions and untested behavior.
3. `system.author_workflow` persists revision 1 as a draft and returns `ready_to_activate` plus a canonical activation proposal containing the full definition and its content hash.
4. The boss passes that proposal to `system.activate_workflow`.
5. The high-risk approval card shows the exact revision contract. Approval revalidates readiness and atomically publishes the revision, primes scheduling, and sets desired status active.
6. Each occurrence claims one durable occurrence identity, creates a revision-pinned run, passes an async readiness guard, and executes the interpreted brief.
7. History reports what triggered the run, which revision ran, what it read or changed, and whether it completed, did nothing, waited, was blocked, failed, or produced an unknown write outcome.

### Missing or unhealthy setup

If the user asks for Slack while Slack has no tool surface, or asks for a Gmail write without its required permission:

1. Save the proposal as a blocked draft.
2. Name the exact reason:
   - `not_connected`;
   - `needs_reauth`;
   - `missing_scope`;
   - `choose_account`;
   - `resource_not_granted`;
   - `feature_disabled`;
   - `no_tool_surface`;
   - `trigger_not_ready`;
   - `provider_unhealthy`.
3. Offer only a truthful recovery action. `no_tool_surface` must not masquerade as “connect Slack”; Alfred cannot automate it yet.
4. Return from connect/reauthorize to the same draft, rerun readiness, and present activation when satisfied.

The invariant is **no runnable unsatisfied revision**, not “nothing persists.”

### Preview and test semantics

Do not use “dry run” as one vague feature:

- **Definition validation:** deterministic schema, trigger, tool, account, permission, policy, and trigger-readiness checks. No model call and no external effects.
- **Plan preview:** an illustrative interpreted pass against a frozen capability catalog; writes become `would_propose` records and cannot dispatch. This previews likely behavior but does not promise the same nondeterministic path later.
- **Run a test now:** a real manual/test occurrence. Real reads may happen; every external write retains normal approval floors and the UI says so explicitly.
- **Fixture regression:** CI-only replay against captured provider/tool results and a fixed clock; assertions target structured outcomes, not exact prose.

A successful live test is recommended, not universally required for activation. Some event workflows have no representative author-time input, and some meaningful tests would create undesirable side effects.

## User Stories

1. As the user, I can describe recurring or event-driven intent in plain language and receive a saved, editable proposal.
2. As the user, I can leave for connection setup and return to the same blocked draft without restating my request.
3. As the user, I approve the exact timezone-resolved trigger, next run, account/resource selection, allowed tools, assumptions, and possible external effects before activation.
4. As the user, editing an active workflow creates unpublished changes; the published revision keeps running until I activate the new revision.
5. As the user, I can distinguish Preview from a real Test Run and understand whether either can change an external system.
6. As the user, History tells me which revision and trigger input ran, what effects completed, why work was blocked or skipped, and which recovery actions are safe.
7. As the user, reconnecting an account lets me resume or replay held work without silently repeating an ambiguous write.
8. As the operator, each cron/manual/event occurrence has one durable database identity independent of queue retention and terminal run status.
9. As the operator, each logical write effect has an identity stable across attempts and an explicit `unknown` state when delivery cannot be proved.
10. As the operator, cancelling a run fences later commits and dispatches even if a step was already in flight.
11. As the operator, event workflow health includes subscription provisioning, renewal, delivery health, and provider-native recovery cursors—not merely credential health.
12. As the boss, I can propose only exact registered tools within the authorable trigger subset; a capability outside the approved envelope produces a typed mismatch rather than silent expansion.
13. As the developer, chat authoring and future UI authoring use the same draft/revision/activation services.

## Definition and Lifecycle Model

### Workflow identity and immutable revisions

Keep `workflows` as the stable user-facing identity and control row. Add immutable `workflow_revisions`:

```text
workflows
  id, user_id, slug
  current_revision_id       -- newest draft
  published_revision_id     -- definition used for new occurrences
  status                    -- draft | active | paused | archived (user intent)
  blocked                    -- nullable operational blocker, separate from pause
  next_run_at, last_scheduled_at, last_run_*
  row_version, timestamps

workflow_revisions
  id, workflow_id, revision_number, content_hash
  name, description, brief, trigger
  allowed_integrations      -- coarse integration ceiling
  allowed_tools             -- exact tool execution envelope
  required_capabilities     -- tool + account/resource requirement
  authoring_proposal        -- original intent/assumptions for review
  created_by_run_id, approved_at, timestamps

agent_runs
  workflow_revision_id
  occurrence_key
  runtime_build_id / tool_catalog_hash
  terminal_outcome
```

Rules:

- Any semantic edit creates a revision; revisions are never edited in place.
- `current_revision_id` may move while the published revision continues to run.
- Activation validates and assigns `published_revision_id = current_revision_id`.
- A trigger reads `published_revision_id` once and pins it on the run.
- Waiting/running runs continue against their pinned definition. A deploy records runtime lineage and must fail explicitly on an incompatible resume rather than silently reinterpret the workflow.
- `status='paused'` means the user paused future occurrences. Operational readiness lives in `blocked`, so connection health does not overwrite user intent.
- Reactivating or publishing always goes through the same validation service as creation.

### Capability contract

Model-facing proposal:

```ts
{
  name: string;
  description?: string;
  brief: string;
  trigger: AuthorableWorkflowTrigger; // cron | gmail event | manual
  capabilities: Array<{
    tool: ToolName;
    accountRef?: string;
    resourceScope?: unknown;
  }>;
}
```

The server derives the integration ceiling from required tools plus the event source. It may accept an explicit narrower ceiling, but never an empty/unrestricted ceiling for a newly authored workflow.

The validated revision stores:

- `allowed_integrations`: coarse dispatcher backstop;
- `allowed_tools`: exact names the run may activate or dispatch;
- `required_capabilities`: exact tool, account/workspace/installation, permission, resource boundary, and readiness requirements.

`resolveWorkflowCapabilities` is pure over a supplied availability/tool-catalog snapshot:

```ts
resolveWorkflowCapabilities({
  requested,
  trigger,
  availability,
  registeredTools,
}): {
  satisfied: boolean;
  resolved: ResolvedWorkflowCapability[];
  missing: WorkflowCapabilityProblem[];
  allowedIntegrations: IntegrationSlug[];
  allowedTools: ToolName[];
}
```

Use `evaluateToolAvailability` as the final authority so authoring and dispatch share caller, thread, feature-flag, credential, and scope semantics. Extend the resolver for selected account and resource access where the current snapshot is too coarse.

Boss enumeration is a proposal, not proof of completeness. Deterministically union explicit `@` mentions and trigger source, show the exact envelope on the card, and enforce it at runtime. If the interpreted run requests a tool outside `allowed_tools`, return `capability_mismatch`, end or block the run honestly, and require a new revision. Do not silently widen an unattended workflow.

### Tool availability and risk

- `system.author_workflow`: `riskTier: 'no_risk'`, `availability: { requiresThread: true, callers: ['boss'] }`. It may create/update an internal draft but cannot activate it. Its result includes the server-canonical activation proposal; the boss copies that proposal rather than reconstructing it.
- `system.activate_workflow`: `riskTier: 'high'`, `availability: { requiresThread: true, callers: ['boss'] }`. Its staged input includes workflow/base-revision identity, content hash, full definition, concrete schedule preview, resolved account/capability display, assumptions, and external-effect categories—never only opaque IDs. The existing schema-driven approval surface can therefore render what is being activated. The high-risk floor produces the activation approval.
- Post-approval execution revalidates and canonicalizes the submitted definition. If the user edited fields on the approval card, the service creates a new immutable revision from the approved definition, validates it, and publishes that revision; it never mutates the base revision. If canonical fields/hash no longer match or readiness drifted, activation stops with a typed stale/blocker result instead of publishing a different contract.
- A background workflow cannot author or activate another workflow.
- Activation approval does not waive runtime approval. Each concrete external mutation still follows dispatcher policy and the ADR-0069 high-risk floor.
- Approval binds the exact revision/effect/account/arguments. After a long wait, execution rechecks authorization, connection, resource access, and mutable safety preconditions.

## Trigger and Event Readiness

### Cron and manual

- Resolve natural language to a concrete five-field cron and IANA timezone before activation.
- Show the friendly schedule and next expected run in the activation card.
- A manual/test occurrence uses a caller-supplied request ID for durable dedup.
- Resume defaults to the next future cron occurrence. Catching up missed occurrences is explicit, never an accidental replay loop.

### Event v1

The authorable event subset remains `gmail.message_received` with no dispatcher filter. The UI and activation card must say that Alfred starts a run for every delivery and evaluates semantic conditions inside the interpreted run. It must not imply provider-side filtering.

Activation requires `triggerReady`, independently of capability health:

- subscription/watch provisioned for the selected account;
- renewal not overdue;
- receiver/signature and delivery path healthy;
- recovery cursor usable;
- no known coverage gap that makes the trigger misleading.

A pre-run guard cannot detect a dead event stream because no event creates the run. Maintain a minimal generic event control plane:

1. **Subscription record:** provider-native IDs, credential/account, resource selector, status, expiration, renew-before time, last setup/renewal, and last verified delivery.
2. **Durable event receipt:** provider, stable delivery ID, subscription, received time, verification result, payload hash/pointer, and processing status; unique by provider delivery identity.
3. **Provider cursor/checkpoint:** Gmail `historyId`, Calendar `syncToken`, GitHub delivery audit watermark, or workflow-specific reconciliation state for providers without a general cursor.
4. **Provider-specific recovery:** renewal, failed-delivery audit, incremental reconciliation, or an explicit coverage gap. Do not pretend cursor semantics are generic.

For Gmail v1, reuse the existing watch/history infrastructure and expose its actual readiness to workflow activation. Broader Slack/Linear/GitHub/Calendar authorable triggers remain future additions, but the control-plane shape must not preclude their retry and renewal models.

## Runtime Contract

### Durable occurrence identity

Queue job IDs and status-sensitive queries are not the source of truth. Persist one database-unique `occurrence_key`:

- cron: workflow ID + published revision ID + scheduled instant;
- provider event: workflow ID + provider + stable delivery/event ID (normally omit revision so an edit does not replay the same event);
- manual/test: client-generated request ID;
- replay: a new occurrence linked by `replay_of_run_id` and an explicit original/latest revision choice.

Claim the occurrence and create its pending run transactionally. Advance the cron cursor in that transaction. Enqueue after commit; the existing recovery sweep can enqueue a pending row after Redis/process failure. Event receipt processing uses the unique occurrence claim instead of “no nonterminal run exists,” so a redelivery after completion does not create a second run.

### First async step: `check-readiness`

`userAuthoredBriefWorkflow.initialState` is synchronous and cannot perform database-backed readiness checks. Add an async first step before `boss-turn`:

1. Load the run's pinned revision.
2. Resolve every required capability and account/resource boundary against current state.
3. Confirm event trigger readiness when applicable.
4. On a terminal readiness failure, complete the occurrence as `blocked`, set the workflow's operational blocker, and notify once.
5. On a transient provider outage or rate limit, mark the occurrence `deferred` and retry under a bounded policy; do not misclassify it as reauthorization or immediately pause the workflow.
6. On success, continue to `boss-turn` with the pinned brief and exact tool envelope.

Dispatcher checks remain authoritative immediately before every tool effect, closing the race where authorization changes after the first step.

### Logical effect identity and unknown outcomes

Attempt identity and effect identity are separate:

```text
effect_key       stable across attempts of one logical tool call
attempt_key      changes on retry/reclaim
request_hash     canonical tool + args + target account/resource
provider_key     same effect key when provider supports idempotency
provider_ref     remote request/object/message id when known
outcome          planned | awaiting_approval | dispatching |
                 succeeded | failed | unknown | compensated
```

Extend the existing staging/execution ledger rather than treating `${runId}:${stepId}:${attempt}` as a safe downstream effect key. Retry rules:

- reads may retry;
- natural set/upsert operations may retry after target/precondition validation;
- provider-idempotent writes retry only with the same provider key and payload;
- reconcilable writes read after write before deciding;
- possibly delivered, non-idempotent, unreconcilable writes become `unknown` and never auto-retry.

The model receives an explicit non-actionable unknown envelope. A fresh tool-call ID must not bypass an unresolved ambiguous-effect barrier.

### Cancellation and pause semantics

- **Pause workflow:** stop future occurrence creation; do not mutate a current run.
- **Pause run:** park at the next safe boundary with revision/effects intact.
- **Cancel run:** increment a cancellation generation/fence, reject pending approvals, prevent later step commits from advancing the run, and recheck the fence immediately before effect dispatch.
- **Retry failed step:** same run, revision, occurrence, and logical effect keys.
- **Run again:** new occurrence; choose original or latest revision explicitly.

Cancellation is cooperative, not retroactive. History must still show effects that completed or remain unknown before the fence.

## Run History and Operational Legibility

`agent_runs` remains the runtime row; do not add a redundant `workflow_runs` table. Enrich it and expose a bounded paginated projection to the real History tab.

Persist a typed terminal outcome:

```ts
type WorkflowRunOutcome =
  | { kind: "completed"; summary: string; effects: EffectReceipt[] }
  | { kind: "no_change"; summary: string }
  | { kind: "deferred"; code: string; retryAt?: string }
  | { kind: "blocked"; code: string; recovery: RecoveryAction[] }
  | { kind: "failed"; code: string; safeMessage: string }
  | { kind: "cancelled"; completedEffects: EffectReceipt[]; unknownEffects: string[] }
  | { kind: "unknown_write_outcome"; effectKey: string; safeToRetry: false };
```

Each history row shows:

- occurrence/trigger kind, exact input identity, scheduled/received time;
- workflow revision and whether it is still current;
- started/ended/status and concise output summary;
- completed, rejected, waiting, failed, and unknown effects;
- capability or trigger coverage gaps;
- a safe recovery action: reconnect, reauthorize, retry same run, run again from original/latest revision, inspect, or no automatic retry.

Replace the current preview History and Approvals data. Update `workflows.last_run_*` on terminal commit for list-page summaries; use the paginated run projection for details rather than transcript archaeology.

## Sync, Materialization, and Vectors

No generic content sync/indexing engine is a v1 prerequisite. Keep these needs separate:

| Need                                    | Substrate                                                         |
| --------------------------------------- | ----------------------------------------------------------------- |
| Fresh current truth or one-off mutation | Live integration tool/API                                         |
| Webhook audit, dedup, renewal, recovery | Subscription + receipt + provider cursor control plane            |
| Exact lifecycle across runs             | Demand-driven provider reducer / `integration_objects` projection |
| Semantic recall over large text history | Selected `documents`/chunks + pgvector                            |

An issue becoming a vector does not establish whether it is open, whether a delivery was already applied, or whether a write is safe to retry. Those require exact identities, state, cursors, and an effect ledger.

Materialize only after a workflow proves a repeated exact-state need. Add embeddings only after it proves a semantic historical-retrieval need. A one-shot event reaction needs a durable receipt, processed key, and live fetch—not a full provider mirror.

## Compiled / Self-Syncing Graduation

The local `~/Developer/oss/self-syncing-agent` proves a useful later tier: an agent authors a handler, schema, signature verifier, subscription registration, and egress allowlist once; approved code then handles steady-state webhooks without an LLM.

That is not merely ADR-0087 code mode. ADR-0087 is thread-scoped, TTL-bound context virtualization in a network-less transient isolate. Persistent handlers additionally need:

- durable versioned code and definition linkage;
- event ingress, signature verification, subscription registration/renewal/cleanup;
- per-workflow state/schema migration and rollback;
- stable dedup and effect identity;
- controlled secretless egress and resource budgets;
- observability, error recovery, shadowing, and rollback;
- a persistent-code threat model covering prompt-injected payloads.

Use a graduation ladder:

1. interpreted brief;
2. interpreted brief with typed capability/effect envelope (this v1);
3. deterministic prefilter/reducer or outer graph with agent judgment nodes;
4. generated persistent handler, with an agent invoked only for selected deliveries.

Compilation creates a new workflow revision and shadows against fixtures/live-read inputs. It never silently replaces the interpreted revision. Evidence gate: meaningful volume, low normalized path entropy, stable provider schemas, deterministic invariants and fixtures, safe idempotency/reconciliation, no unresolved unknown effects, and a measured cost/latency or risk win.

## Implementation Seams

- **Draft/revision service:** `packages/api/src/modules/workflows/` owns create draft, revise, validate, activate, and reactivation. Both tools and the future UI mutator call it.
- **Capability resolver:** pure module over availability + registered tool snapshots; no hidden network calls. A separate boundary gathers account/resource facts.
- **Tools:** add `system.author_workflow` and `system.activate_workflow` to contracts and `packages/api/src/modules/tools/system.ts` with the availability/risk rules above.
- **Dispatcher:** add exact `allowed_tools` enforcement, stable logical effect keys, ambiguous-outcome barriers, approval revalidation, and cancellation fence checks.
- **Runtime:** add revision-pinned resolution, durable occurrence claims, async `check-readiness`, typed outcomes, terminal `last_run_*` updates, and paginated history reads.
- **Events:** expose Gmail watch/cursor health, persist durable receipts, and create event occurrences from stable delivery identities.
- **Web:** chat activation card; blocked-draft recovery; concrete trigger/next-run rendering; real History and Approvals tabs; active-vs-unpublished-changes state.
- **Database:** use named Drizzle row types and `$inferInsert`; generate and migrate through `pnpm db:generate` then `pnpm db:migrate`.

## Schema / Contract Deltas

At minimum:

- `workflow_revisions` table plus `workflows.current_revision_id`, `published_revision_id`, and `blocked`.
- Revision fields for exact `allowed_tools`, `required_capabilities`, proposal assumptions, and content hash.
- `agent_runs.workflow_revision_id`, `occurrence_key`, runtime/tool-catalog lineage, and typed terminal outcome.
- A database uniqueness constraint for occurrence identity across terminal and nonterminal runs.
- Stable effect identity/outcome fields on the existing staging/invocation ledger; do not create a second competing write ledger.
- Subscription, durable receipt, and provider-cursor records only to the degree not already owned by current Google watch/ingestion infrastructure.
- Replicache contracts for workflow identity/draft/readiness fields and either a bounded synced run-summary entity or an authenticated paginated History route. Do not sync full transcripts merely to render History.

## Non-Goals

- Declarative DAG authoring or execution.
- Automatic compilation or persistent generated handlers.
- Reusing ADR-0087 by silently widening its security/runtime charter.
- A universal integration content mirror.
- Embedding every provider object.
- Provider-agnostic cursor or reducer semantics.
- Silent runtime degradation outside the approved exact tool envelope.
- Automatic retry of an ambiguous external write.
- A promise of deterministic replay for LLM reasoning.

## Test Plan

### Unit / pure contracts

- Exact capability resolution: active, disconnected, needs reauth, missing scope, feature disabled, wrong account/resource, no tool surface, and trigger source inclusion.
- The integration ceiling and allowed tool envelope are derived deterministically and never empty/unrestricted for authored revisions.
- Drafts persist with blockers; activation refuses any unsatisfied capability or trigger.
- Semantic edits create immutable revisions; active runs retain their pinned revision.
- Concrete cron/timezone/next-run rendering and authorable trigger validation.
- Typed outcome and recovery-action mapping.

### Database / runtime

- Duplicate cron, manual, and provider event occurrence keys create one run even after the first run is terminal.
- Crash after occurrence claim but before enqueue is recovered from the pending row.
- Crash after provider acceptance but before local effect commit yields dedup/reconciliation or `unknown`, never a blind duplicate.
- Reclaim changes attempt identity but preserves logical effect identity.
- Cancellation during a live step cannot advance/complete the cancelled run or dispatch a later effect.
- An approval resumed after state drift revalidates or asks again.
- Terminal credential loss blocks future occurrences and reports one recovery path; transient outage/rate limit defers without pretending reauth.

### Event lifecycle

- Authoring an event workflow cannot activate unless its trigger is provisioned and healthy.
- Duplicate Gmail/Pub/Sub receipts create at most one occurrence.
- Watch renewal, stale cursor, and known coverage gap surface trigger readiness honestly.
- Absence of delivery never produces a confident “no matching events” when coverage is degraded.

### E2E / evals

1. Chat → ready draft → exact activation card → approved published revision → scheduled occurrence → honest History row.
2. Slack request → blocked draft with `no_tool_surface`, no fake connect action, no active revision.
3. Gmail write with read-only connection → blocked draft naming missing permission.
4. Edit active workflow → unpublished revision while old published revision continues; activate new revision explicitly.
5. Runtime tool request outside the approved envelope → `capability_mismatch`, no silent widening.
6. Reconnect flow returns to the original draft and activates only after revalidation.

### Live smoke

Author a daily read-only workflow against a connected account; confirm concrete schedule, activation, occurrence claim, interpreted execution, and History. Then revoke/reconnect the credential and confirm block/recovery without duplicate effects.

## Acceptance Criteria

- No user-authored workflow becomes runnable without an exact approved revision and satisfied capability + trigger readiness.
- Missing setup preserves the user's draft and offers a truthful next action.
- Every run is attributable to one immutable workflow revision and one durable occurrence.
- Every write effect has stable logical identity across attempts and can represent `unknown`.
- Cancellation fences later commits/effects.
- Event health is monitored outside runs; degraded coverage is visible.
- History is backed by real run/effect data, not preview rows or transcript inference.
- V1 ships on the interpreted executor without requiring sandbox/code mode, a DAG engine, a universal mirror, or speculative vectors.

## Remaining Product Decisions

1. **Reconnect auto-resume:** recommended default is auto-clear an operational blocker and resume future occurrences only when the unchanged published revision remains user-desired active; never auto-replay held/unknown work.
2. **Multiple eligible accounts:** require explicit selection before activation; do not rely on Copilot-style heuristics for unattended work.
3. **Blocked notification channel:** reuse the approval-notification worker for terminal blockers, deduped by workflow + blocker generation; pair it with an in-app status.
4. **History transport:** choose bounded Replicache run summaries if offline/multi-device History matters immediately; otherwise prefer an authenticated paginated route and keep transcripts server-side.
5. **Plan preview scope:** land only if writes are structurally replaced with `would_propose`; a prompt instruction alone is not a safe preview boundary.
