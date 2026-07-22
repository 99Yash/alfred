# Workflows v1 — runtime and execution semantics research

**Date:** 2026-07-22  
**Scope:** interpreted agent loops, deterministic/compiled execution, durable recovery, revisions, retries and unknown outcomes, pause/resume/cancellation, dry-run/testing, approvals, and compile-on-maturity.  
**Inputs reviewed:** `docs/plans/workflows-v1.md`; ADR-0006, ADR-0014, ADR-0017, ADR-0025, ADR-0027, ADR-0040, ADR-0043, ADR-0047, ADR-0053, ADR-0069, ADR-0071, ADR-0087; Alfred's current workflow schemas and executor. External claims below use only first-party documentation or owning-project source/docs.

## Bottom line

The plan is directionally right to ship v1 as an interpreted, brief-only agent loop. A declarative DAG interpreter, sandbox, sync engine, or “compiled endpoint” is not required to learn whether chat-authored workflows are useful. But the current plan is not yet a safe runtime contract. Four changes should be treated as v1 foundations rather than future polish:

1. **Pin every run to an immutable workflow revision.** The run already copies the brief, but it does not pin the complete definition or runtime code/policy revision. Edits should affect future runs only; a waiting run must resume against the exact definition it started with.
2. **Separate retry identity from effect identity.** Alfred's default idempotency key contains `attempt`, which deliberately changes after reclaim. That is useful for attempt telemetry and dangerous as the identity of a logical outbound effect: the same email/post/update can be issued again after an ambiguous failure.
3. **Represent `unknown` as a first-class effect outcome.** A timeout after sending a request is not proof of failure. Blind retry is correct only when the provider honors a stable idempotency key or Alfred can reconcile the remote state.
4. **Fence cancellation.** The current cancellation path changes status but does not appear to invalidate the running attempt, while the later step commit is guarded by run ID and attempt only. An in-flight step can therefore potentially commit after cancellation. “Cancel” must mean “no new effects after the cancellation fence,” while honestly admitting that an already-started remote effect might finish.

The key product distinction is not “agentic versus deterministic.” It is:

- **authored intent** — a mutable user-facing workflow;
- **immutable revision** — the approved definition used by a run;
- **run** — a durable record of what actually happened;
- **attempt** — one execution try of a step;
- **effect** — one logical outside-world mutation, stable across attempts.

Without those identities, a happy-path demo will work, but edits, deploys, timeouts, approvals, and cancellations will remain ambiguous.

## 1. What the durable-execution systems actually guarantee

### 1.1 Durable execution persists boundaries; it does not make arbitrary code exactly-once

Restate describes durable execution as persisting completed operations in a journal, replaying that journal after a crash, and persisting nondeterministic operations such as database writes or external API calls as durable steps ([Restate workflow guide](https://docs.restate.dev/tour/workflows)). Inngest similarly persists the result of each completed `step.run()` and, on retry, resumes at the failed step instead of re-running completed steps ([Inngest error and retry guide](https://www.inngest.com/docs/guides/error-handling)). Trigger.dev distinguishes run-scoped idempotency, which prevents duplicates across retries of one parent run, from attempt-scoped idempotency, which intentionally lets a child execute again on every retry ([Trigger.dev idempotency guide](https://trigger.dev/docs/idempotency)).

These are boundary guarantees. Inngest explicitly warns that a write may have succeeded even if its response timed out and says retried work itself must be idempotent ([Inngest error and retry guide](https://www.inngest.com/docs/guides/error-handling)). The lesson for Alfred is that a checkpointed agent step is not enough: each outside-world effect needs a retry contract of its own.

### 1.2 Replay-based systems constrain code changes; pinning avoids surprise drift

Restate checks replayed operations against the existing journal and reports a mismatch if a deployment reorders operations, adds/removes operations, changes their inputs, or changes conditionals that determine the execution path ([Restate versioning guide](https://docs.restate.dev/services/versioning)). Its deployment model routes new calls to the latest deployment while existing calls continue on their original immutable deployment; a moved invocation still must be compatible with already-written journal entries ([Restate services guide](https://docs.restate.dev/foundations/services), [Restate versioning guide](https://docs.restate.dev/services/versioning)). Inngest uses stable step identifiers and memoized step results so completed steps are not rerun across deployments ([Inngest function versioning](https://www.inngest.com/docs/learn/versioning)).

OpenAI's Agents SDK reaches the same practical conclusion for long-lived approval pauses: serialized run state can resume later, but if agent definitions or SDK versions may change, the application should assign its own code version, store it with the serialized state, and deserialize with the correct version ([OpenAI Agents SDK HITL guide](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/)).

Alfred does not need to copy one engine's replay algorithm. It does need the invariant those designs protect: **a run resumes under a definition compatible with the state it already persisted**.

### 1.3 Cancellation is cooperative, not retroactive

Inngest documents that cancellation takes effect between steps; a currently executing step continues to completion, and pausing a function is a separate control that prevents new runs from being enqueued ([Inngest cancellation guide](https://www.inngest.com/docs/features/inngest-functions/cancellation)). Restate surfaces cancellation at the next awaited durable operation, propagates it through attached calls, and notes that detached one-way calls are not killed ([Restate invocation management](https://docs.restate.dev/services/invocation/managing-invocations)). Both models require cleanup or compensating actions rather than pretending prior side effects were undone ([Inngest cancellation guide](https://www.inngest.com/docs/features/inngest-functions/cancellation), [Restate workflow guide](https://docs.restate.dev/tour/workflows)).

Therefore Alfred should promise “stop before the next cancellable boundary and suppress undispatched effects,” not “undo everything.” Any UI that says merely “Cancelled” must still report already-completed and unknown effects.

### 1.4 Human approval is durable state attached to a specific pending call

The OpenAI Agents SDK pauses before a protected tool executes, records an approval item, persists approval decisions in run state, and resumes from that state rather than starting a fresh turn ([OpenAI Agents SDK HITL guide](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/)). It can run input guardrails before showing approval and reruns them immediately before execution because conditions may have changed while the request waited ([OpenAI Agents SDK HITL guide](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/)). Restate's durable promises/awakeables likewise persist an external wait across crashes and resume when another process resolves or rejects it ([Restate external events guide](https://docs.restate.dev/develop/go/external-events)).

The reusable principle is: **approval authorizes an exact proposed effect, not a vague workflow or tool forever**, and authorization/preconditions should be revalidated at execution time.

## 2. Alfred's current execution model

### Already strong

- `agent_runs` persists workflow state, transcript, current step, trigger, attempt, wake condition, and terminal output/status. `agent_steps` records each `(run_id, step_id, attempt)` before the body runs. See `packages/db/src/schema/agent.ts`.
- The executor leases a run, inserts the attempt row, runs the body outside the transaction, and atomically commits the step result, staged actions, and decision traces. A stale worker's commit is fenced by the attempt comparison. See `packages/api/src/modules/agent/executor.ts`.
- HIL waits are durable `waiting` runs with a `wake_condition`; `signalRun` resumes them. `cancelRun` is idempotent at the API level and rejects still-pending approval stagings. See `packages/api/src/modules/agent/service.ts`.
- The brief-only executor checkpoints each model turn and tool-dispatch round instead of hiding the full loop inside an SDK call. The actual transcript is persisted, so Alfred has an audit trail of the nondeterministic path that occurred. See `packages/api/src/modules/agent/workflows/user-authored-brief.ts` and ADR-0040.
- Workflow dispatch has useful dedup rails: cron fires CAS-update `next_run_at` and give BullMQ a scheduled-instant job ID; event dispatch checks for an existing nonterminal run for the event. See `packages/api/src/modules/workflows/tick.ts` and `packages/api/src/modules/workflows/events.ts`.
- Pending actions have a unique idempotency key, and the dispatcher enforces active-tool and allowed-integration bounds. See `packages/db/src/schema/agent.ts`, ADR-0053, and ADR-0069.

This is sufficient substrate for interpreted v1. Replacing it with Temporal, Restate, Inngest, or Trigger.dev would not remove the need to settle Alfred's product semantics below.

### Gaps the v1 plan currently understates

#### A. The run does not pin a complete definition revision

`createRun` copies the brief and allowed integrations into the run, which protects those values from a later row edit. But `agent_runs` has no `workflow_revision_id` or definition hash, and each step re-resolves the workflow implementation from the current in-memory registry. Tool schemas, system instructions, risk policy, connected-tool resolution, model choice, and sentinel executor code can all change between start and resume.

This is especially important for an approval that waits across a deploy. The user approved one action under one definition; the process may resume under another.

#### B. The default effect key changes on reclaim

`StepContext.idempotencyKey` is `${runId}:${stepId}:${attempt}` and a default staged action adds `kind`. Because reclaim increments `attempt`, a logically identical effect receives a new key. The schema comment calls the key “safe” for downstream calls, but it is only safe when repeat execution is intended or the downstream operation is naturally idempotent. Trigger.dev's explicit distinction is useful here: run scope prevents duplication across retries; attempt scope intentionally repeats the child ([Trigger.dev idempotency guide](https://trigger.dev/docs/idempotency)).

For a `gmail.send`, `slack.post`, issue creation, or calendar mutation, Alfred normally wants one **logical effect key** across all attempts. Attempt ID should remain separate for telemetry and provider-call accounting.

#### C. A crash can occur after the provider changed state but before Alfred committed the result

The tool-dispatch step performs work outside the step-success transaction. If the remote provider accepts the mutation and the process dies before the result commits, the next attempt cannot infer success from Alfred's local step row. This is the standard ambiguous-timeout case Inngest calls out ([Inngest error and retry guide](https://www.inngest.com/docs/guides/error-handling)). A boolean `failed` is dishonest here; the outcome is `unknown` until deduplicated or reconciled.

#### D. Cancellation does not appear to fence the running attempt

`cancelRunInTx` sets `status='cancelled'` but does not increment `attempt`. `commitStepSuccess` updates the run with a predicate on `id` and `attempt`, without also requiring `status='running'`. A step that was already executing when cancellation committed can therefore still pass the attempt guard, advance or complete the run, and stage effects. This is more permissive than the documented cooperative-cancellation models above: they may let an active step finish, but the run remains cancelled and subsequent work is suppressed ([Inngest cancellation guide](https://www.inngest.com/docs/features/inngest-functions/cancellation)).

The fix is a runtime prerequisite: cancellation must advance a fencing token/attempt or success/failure commits must require the lease's expected running status and cancellation generation. Staged/eager effects also need a final cancellation check immediately before dispatch.

#### E. Dispatch dedup has loss/duplicate windows

- Cron dispatch advances `next_run_at` before `createRun` and enqueue. If run creation fails after the CAS, that scheduled occurrence has already moved forward and can be lost unless there is a separate occurrence ledger/reconciler.
- Event dedup checks only nonterminal runs. A duplicate delivery arriving after the first run completes may create a second run for the same provider event.
- A BullMQ job ID deduplicates queue jobs, not durable workflow occurrences across queue retention or manual replay.

These are reasons to persist a `workflow_occurrence_key` on `agent_runs` (or in a small occurrence ledger) with a database uniqueness constraint, rather than relying on queue identity and status-sensitive reads.

## 3. Recommended v1 runtime contract

### 3.1 Keep interpreted execution, but be precise about what is replayable

For brief-only workflows, persist and resume the **observed trajectory**; do not promise deterministic replay of model reasoning.

- A committed model turn and tool result are history and must not be regenerated during ordinary resume.
- If a worker dies before a model turn commits, rerunning that turn is a new attempt and may produce different output. Preserve both attempt metadata and cost, but only the committed result advances the run.
- “Replay” in the UI should mean either (a) inspect the historical run, or (b) start a new run from a named revision/input snapshot. It must not imply bit-for-bit regeneration.
- Deterministic steps can reuse committed outputs. Agent steps should be evaluated by outcome invariants and traces, not exact prose/tool-path equality.

This matches the actual value of Alfred's current transcript/checkpoint design without claiming the stronger deterministic-journal semantics used by replay engines.

### 3.2 Add immutable workflow revisions and pin runs

Use a revision model such as:

```text
workflows
  id, user_id, slug, status, current_revision_id, scheduling cursors...

workflow_revisions
  id, workflow_id, revision_number, content_hash
  name, brief, trigger, required_capabilities, allowed_integrations
  steps?, hil_gates?, authoring_proposal?, approved_at, created_at

agent_runs
  ...
  workflow_revision_id
  runtime_build_id
  policy_version / tool_catalog_hash / prompt_bundle_hash
  occurrence_key
```

Rules:

1. Any semantic edit creates a new revision; never mutate a revision in place.
2. `status` and schedule cursor fields remain mutable workflow controls, not revision content. Changing the trigger schedule creates a revision and recomputes the cursor.
3. A trigger resolves `current_revision_id` once, then atomically inserts a run pinned to it.
4. Waiting/running runs continue on their pinned revision. New runs use the current revision.
5. An operator migration of an in-flight run is an explicit action with compatibility validation and an audit record—not an accidental consequence of deploy.
6. The approval card displays and approves the revision hash. Runtime write approvals additionally bind the exact tool, normalized arguments/effect hash, account/integration identity, and policy version.

Pinning does not make the LLM deterministic. It makes the lineage explainable: Alfred can say which intent, tools, policy, and runtime produced the observed result.

### 3.3 Give triggers a durable occurrence identity

Define a unique occurrence key before creating a run:

- cron: `workflow_id + revision_id + scheduled_for`
- provider event: `workflow_id + provider + stable_event_id` (revision inclusion is a product choice; normally omit it so editing a workflow does not replay the same external event)
- manual run: client-generated request ID
- retry/replay: an explicit new occurrence linked by `replay_of_run_id`

Insert the run and occurrence claim in one Postgres transaction; enqueue after commit; let the existing resume sweep recover an unenqueued pending row. Put the uniqueness constraint in Postgres. Queue job IDs remain an optimization.

### 3.4 Model effect identity and outcome explicitly

For every write-capable tool call, derive:

```text
effect_key       stable across attempts of one logical tool call
attempt_key      changes on retry/reclaim
request_hash     canonical tool + normalized args + target account
provider_key     effect_key forwarded when the provider supports idempotency
provider_ref     remote request/object/message ID when known
outcome          planned | awaiting_approval | dispatching |
                 succeeded | failed | unknown | compensated
```

The model-generated tool-call ID can seed `effect_key`, but it must remain stable when the same pending call resumes. For deterministic steps, use `(run_id, logical_step_instance, effect_slot)`, not attempt. A loop needs a stable iteration/item identity; `step_id` alone is insufficient.

Retry matrix:

| Effect class                                    | After transport timeout / worker loss                                             |
| ----------------------------------------------- | --------------------------------------------------------------------------------- |
| Read-only                                       | Retry; record attempts.                                                           |
| Naturally idempotent set/upsert                 | Retry after verifying target identity and preconditions.                          |
| Provider supports idempotency key               | Retry with the same `effect_key`.                                                 |
| Provider offers read-after-write reconciliation | Query by provider ref or deterministic fingerprint, then mark succeeded or retry. |
| Non-idempotent and unreconcilable               | Mark `unknown`; stop automatic retries; ask the user/operator to reconcile.       |
| Irreversible/high-risk                          | Approval plus stable effect key; never blind-retry an unknown outcome.            |

Do not collapse `unknown` into `failed`. ADR-0071's result-honesty principle should apply to the runtime ledger, not only model-facing tool text.

### 3.5 Separate workflow pause, run pause, cancel, and retry

Use distinct controls:

- **Pause workflow:** prevent creation of future runs; do not silently alter an existing run.
- **Resume workflow:** allow future occurrences from a declared cursor policy. Default to “next future occurrence,” not catch up every missed cron fire. Offer explicit catch-up when useful.
- **Pause run:** park at the next safe boundary; retain its revision and pending approvals.
- **Cancel run:** fence commits and new dispatch immediately; reject pending approvals/actions; report completed/dispatching/unknown effects; optionally launch compensations.
- **Retry failed step:** same run, same revision, same logical effect identities.
- **Run again:** new run and occurrence; user chooses original revision or latest revision.

If an integration becomes unhealthy, pausing the workflow is reasonable for future runs, but the current occurrence should finish as `blocked`/`failed` with a specific capability reason rather than disappearing. The dispatcher must still re-check connection and authorization immediately before each effect; an author-time check and pre-run check cannot close a mid-run revoke race.

### 3.6 Make approvals exact, expiring, and resumable

Keep both layers already implied by the plan:

1. **Authoring approval:** approves creating/activating a named workflow revision.
2. **Runtime effect approval:** required by the existing action policy/risk floor for a concrete outside-world mutation.

An effect approval record should include revision ID, run ID, effect key, tool name, canonical argument hash plus human-readable rendering, target account, risk tier, decided-by/time, and expiry/precondition snapshot. On resume:

- do not ask again for the identical approved effect;
- re-run capability, authorization, and mutable safety preconditions immediately before execution, as the OpenAI Agents SDK recommends for guardrails around long waits ([OpenAI Agents SDK HITL guide](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/));
- if the arguments changed, create a new effect and approval;
- if approval expired or the target state materially changed, re-approve;
- rejection becomes a durable tool result so the agent can adapt, unless the user chose “reject and end run.”

### 3.7 Define testing and dry-run as multiple products, not one magic mode

“Dry-run” cannot prove that a nondeterministic workflow will take the same path tomorrow. Offer explicit levels:

1. **Definition validation:** schema, trigger/timezone, capability names, tool existence, policy bounds, and integration health. No model call and no side effects.
2. **Plan preview:** one interpreted turn against a frozen capability catalog; write tools return “would request approval / would execute” records. Label the path as illustrative, not guaranteed.
3. **Fixture replay:** run the pinned revision against captured tool results/provider fixtures and fixed clock. Assert safety and outcome invariants; never call live writes.
4. **Trace regression eval:** feed historical inputs and compare structured outcomes—tools attempted, risk gates hit, unsupported-capability honesty, duplicate-effect count, final status—not exact prose.
5. **Canary live run:** real reads, all writes forced through approval, explicit canary badge, then promote after review.

Test the runtime itself with crash injection at every boundary: before provider call, after provider acceptance/before response, after response/before local commit, during approval wait, during cancellation, and during deploy/resume. The success criterion is not merely final completion; it is no duplicate logical effect, honest unknown outcomes, and revision-consistent resume.

## 4. Interpreted versus compiled: use a ladder, not a fork

The plan's “interpreted-only v1, compile later” choice is sound, but **frequency alone is not a sufficient compilation trigger**. A high-frequency workflow whose semantics remain judgment-heavy does not become safe merely by generating code. Conversely, a low-frequency but high-risk workflow may deserve a deterministic outer shell because reviewability matters more than cost.

Use four rungs:

1. **Interpreted brief:** boss decides the path each run. Best for novel intent, sparse executions, and judgment-heavy work.
2. **Interpreted with typed recipe:** deterministic trigger/capability/effect contracts, agent still selects actions. This should be v1's real target.
3. **Deterministic outer graph with agent nodes:** stable gather/write/approval structure; model used only where judgment is required. ADR-0017 already anticipates this hybrid.
4. **Compiled handler:** approved, sandboxed code for a stable high-volume path; no LLM in steady state except explicitly retained nodes.

A workflow earns promotion when observed runs show all of the following:

- enough volume that model cost/latency or failure exposure is material;
- low path entropy: the same tool/step structure dominates;
- stable input/output schemas and provider APIs;
- objective invariants and a fixture corpus exist;
- write effects have stable idempotency/reconciliation contracts;
- exceptions are identifiable and can fall back to the interpreted path;
- the generated artifact can be reviewed, versioned, sandboxed, rolled back, and shadowed before activation.

Suggested evidence gate: at least a configurable sample (for example 30–100 successful occurrences), ≥95% sharing one normalized trajectory, no unresolved unknown effects, and a measured cost/latency win. Those numbers are Alfred recommendations, not vendor facts; instrument first and tune from real data.

Compilation should produce a **new workflow revision** with a declared execution mode and shadow it against captured/live-read inputs. It should not silently replace the interpreted definition. Keep the old revision available for run history and rollback. ADR-0087's isolate can later host compiled handlers, but code-mode context virtualization is not a prerequisite for interpreted v1.

## 5. Decisions to add to `workflows-v1.md` before implementation

### Must decide for v1

1. Immutable `workflow_revisions` plus `agent_runs.workflow_revision_id` (or an equivalent immutable snapshot/hash).
2. Durable, database-unique occurrence keys for cron, events, and manual requests.
3. Stable logical `effect_key` independent of attempt; effect outcome includes `unknown`.
4. Provider/tool retry capability metadata: idempotency support, reconciliation strategy, and retry class.
5. Cancellation fencing so an in-flight attempt cannot advance a cancelled run or stage post-cancel effects.
6. Exact approval binding and revalidation after waits.
7. Explicit pause/catch-up policy and “retry” versus “run again” semantics.
8. A non-mutating definition validator and fixture-based crash/retry tests.

### Can remain deferred

- declarative DAG authoring/executor;
- persistent compiled handlers and sandbox/code-mode;
- a general sync/vector engine;
- automatic compilation;
- sophisticated saga authoring UI.

### Recommended v1 product posture

Persist the workflow as `draft`, run definition validation plus a plan preview, show the exact resolved schedule/capabilities and illustrative actions, then let approval activate the immutable revision. A first successful live run need not block activation, but the workflow page should distinguish `never_run`, `healthy`, `blocked`, `unknown_effect`, and `paused`. The current proposal's direct `active` insert is defensible only if the preview and runtime ledger make that uncertainty legible.

## 6. Final pressure-test of the plan's main claims

| Plan claim                                      | Assessment                                                                                                                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| “Interpreted-only v1 is enough.”                | **Yes.** It is the right learning slice, provided revision/effect semantics land first.                                                                                    |
| “Runtime is unchanged.”                         | **No.** Pre-run capability health alone is insufficient. Occurrence identity, revision pinning, cancellation fencing, and unknown-effect handling require runtime changes. |
| “No sandbox/code-mode needed.”                  | **Yes for interpreted v1.** Needed only for later persistent compiled handlers.                                                                                            |
| “No sync/indexing engine needed.”               | **Yes.** Runtime correctness is an identity/journal/effect problem, not an embeddings problem.                                                                             |
| “Author-time hard gate prevents degraded runs.” | **Partly.** Connections and permissions can change after authoring or during a run; dispatch-time enforcement and explicit blocked outcomes remain mandatory.              |
| “High frequency earns compilation.”             | **Incomplete.** Require high volume **and** low trajectory entropy, stable schemas, test fixtures, idempotent effects, and safe fallback.                                  |
| “Approval card is the security gate.”           | **Only for authoring.** It authorizes activation of a revision; existing risk policy must still gate concrete runtime mutations.                                           |
| “A run report over `agent_runs` is enough.”     | **Only if enriched.** It needs revision/occurrence identity and per-effect states, especially `unknown`, not just run-level success/failure.                               |

The strongest v1 is therefore not “a prompt on a cron.” It is an interpreted agent workflow with immutable intent, durable occurrence/effect identity, exact approvals, and honest recovery semantics. That foundation also makes the later deterministic DAG and compiled-handler directions substantially safer and easier.
