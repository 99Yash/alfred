# ADR-0040 — m13 Phase 4 brief-only execution: ping-pong steps, sentinel workflow, dedicated transcript column, system-tool autonomy override


**Decision.** Phase 4 of m13 replaces the current registry-miss behavior for user-authored workflows with a real `AlfredAgent`-driven loop. Eight coordinated micro-decisions compose this:

1. **Two named executor steps that ping-pong.** `boss-turn` runs exactly one `AlfredAgent.turn()`; `dispatch-tools` routes each returned tool call through `dispatchToolCall` (ADR-0034) and appends results to the transcript. Each cycle ends with `next: 'boss-turn'`, `done`, or `interrupt`.
2. **User-authored slug resolution via a single sentinel `Workflow<S>`.** `requireWorkflow(slug)` stays strict for code-registered workflow lookup. `resolveWorkflowForRun({ userId, workflowSlug })` returns the registry hit when one exists; otherwise it checks `workflows (userId, slug)`. A missing row OR `is_builtin=true` throws (covers deleted-builtin deploy bugs); `is_builtin=false` routes through the shared `userAuthoredBriefWorkflow` sentinel. `createRun` must still insert the requested slug into `agent_runs.workflow_slug`, not the sentinel slug, so history joins back to the user-authored row.
3. **Dedicated `agent_runs.transcript jsonb` column** typed `AgentTranscriptMessage[]` from `@alfred/contracts`. `Workflow.initialTranscript(input)` seeds it at run creation; the executor leases it with the run row and `StepResult` can carry an optional replacement transcript that commits atomically with the step result. `BriefRunState.inFlightTailStart` records the compaction boundary for the current turn. The Phase 7 compactor rewrites the same column in place. `@alfred/api` casts/converts the stored structural type to AI SDK `ModelMessage[]` only at the `AlfredAgent.turn()` boundary, keeping `@alfred/db` free of an `ai` dependency.
4. **Strict `@`-mention seed.** `state.activeIntegrations` at run start = `INTEGRATION_SLUGS ∩ parsed @-slugs in brief ∩ workflows.allowed_integrations`. An empty seed is legitimate; the boss grows the set via `system.load_integration`. No fallback to "all connected integrations." (Refines ADR-0026; see amendment there.)
5. **System-tool dispatch contract.** `system.*` tools register via the same `liveTool` factory. The dispatcher applies a structural `if (integration === 'system') policyMode = 'autonomy'` short-circuit before `resolvePolicyMode`. State-changing system tools (`load_integration`, future `spawn_sub_agent`) take the full audit-row path; chatty no-op-side-effect tools (`read_scratch`, `write_scratch`, `promote` in Phase 6c) get a fast-path that skips staging. **Tool `execute` is pure** — it validates against context supplied by the step (for `load_integration`, the workflow allowlist) and returns a structured allowed/not-allowed result. Mutation of `agent_runs.state` happens in the `dispatch-tools` step body via a small switch on `toolName`, never via tool internals reaching into `db()`.
6. **Stable system prompt; brief in the first user message.** The cache-stable `system` block holds a user-stable preamble (Anthropic's 10-section template: role / tone / rules / examples / think / format). The workflow brief is the first `user` message in the transcript. `activeIntegrations` is reflected only via the per-turn `tools` resolver — never narrated in `system` — so `load_integration` calls don't break the system cache.
7. **`description: string` required on `RegisteredTool`.** No default fallback; missing description breaks the build. Backfill the four existing tools (`gmail.search`, `gmail.send_draft`, `calendar.list_events`, `calendar.create_event`) and add one for `system.load_integration`.
8. **Smoke via auto-approve.** `smoke-brief-execution.ts` exercises the loop with `default_mode='gated'` intact — the smoke approves any pending `action_stagings` via direct DB write + `signalRun()` mid-loop, covering both the autonomous and gated/resume paths in one run.

**Why each piece.**

- **Ping-pong over a single self-looping step.** One `boss-turn` row maps 1:1 to one `api_call_log` row (ADR-0015 invariant). `interrupt` for HIL falls out of `dispatch-tools` when the dispatcher returns `kind: 'staged'`. Crash-resume is sharper: a dispatch failure restarts only the dispatch loop, not a fresh LLM call. Phase 7's `compact-transcript` step slots in as a third named step without restructuring. The cost — twice as many `agent_steps` rows per turn — is irrelevant at single-user scale and makes the History tab more legible (the alternation is the agentic shape, narrated honestly).

- **Single sentinel workflow + existence check on miss.** User-authored brief-only workflows share their entire execution shape; only `agent_runs.workflow_slug` distinguishes runs. Registering one code-side `Workflow<S>` is the only sane approach that scales to N user workflows per user. Alternatives — registering per-slug at boot (requires restart per user create), lazy-registering per slug (per-slug state for no gain), making `requireWorkflow` async (ripples through every strict lookup) — all fail one or more of: zero-restart UX, no extra state, executor signature clarity. The `is_builtin=true` branch of the existence check stops a deleted-builtin deploy from silently masquerading as a user workflow. Preserving the requested slug in the run row is load-bearing; otherwise every user-authored run would join to `__user-authored-brief__` instead of the workflow the user edited.

- **`agent_runs.transcript` as a sibling jsonb.** Folding the transcript into `agent_runs.state` pollutes a deliberately-small structured shape and forces every step (including non-LLM ones like Phase 7's `compact-transcript`) to drag the full transcript through `ctx.state`. A child message table is premature optimization at single-user scale and fights Phase 7's compactor (which rewrites the view). Redis-primary mirrors ADR-0036 but solves a problem we don't have: transcript writes are one-per-turn, not concurrent. The executor needs first-class transcript plumbing so step bodies do not fall back to side-channel DB writes or `state.transcript`.

- **Strict-seed `@`-mentions.** Permissive seeding (all connected integrations) makes the same brief produce a different toolset on different days and breaks Anthropic's tool-definition cache stability across runs. Strict seeding makes authoring intent explicit, costs at most one extra round-trip per integration the boss needs to load mid-run, and is relaxable later without a migration. ADR-0026 amended above.

- **Structural autonomy for `system.*`.** Seeding `user_action_policies.integration_rules.system = { mode: 'autonomy' }` at signup (Phase 1c) is the data answer. The belt-and-suspenders dispatcher short-circuit means the invariant *"`system.*` is structurally non-gateable"* survives a future user toggle, a missing default row, a botched migration, or a policy-editor bug. Six lines in `dispatchToolCall`; cost-free defense in depth.

- **Pure `execute`; step body interprets state mutations.** The executor reads `state` at step start (`executor.ts:96`) and writes it at step commit (`executor.ts:288`). Side-channel writes during dispatch race the commit. Returning a structured result and applying it in the step body keeps all state writes in one transactional path — the executor's contract stays uniform, and the system-tool effect is *one* known place to read for "what does load_integration actually do" rather than spread across tool internals, dispatcher branches, and runtime context.

- **System prompt cache stability.** ADR-0026's strict-pinning catches accidental system drift across turns within a single `AlfredAgent` instance. The executor instantiates a fresh `AlfredAgent` per step, so the protection is per-step only — useless across the run. The actual concern is byte-identical `system` across turns in a run (Anthropic prompt cache) and across runs of all user-authored briefs (cross-run prefix hits). Putting the brief in the first user message — not `system` — maximizes the shared prefix per user. Tool definitions flow through the SDK's `tools` field, so `load_integration` growing the active set never touches the system block.

- **Required tool description.** Without it, the model picks tools by name guess. Optional-with-default would silently hide a registration bug; required at the type level breaks the build.

- **Auto-approve smoke.** Covers both the autonomous and the gated/resume paths in one run, mirrors how the real user will use Alfred (default-gated), and produces a reusable "approve N pending stagings" helper for Phase 5's UI tests.

**Step shape (pseudocode).**

```
boss-turn:
  transcript = ctx.transcript
  agent = new AlfredAgent({
    system: PREAMBLE,                                          // stable per user
    tools: () => resolveSdkTools(state.activeIntegrations),    // re-read per turn
    model: getBossModel(),
  })
  result = await agent.turn({ ctx, transcript })
  state.turnCount += 1
  if state.turnCount > TURN_CAP_MAX → throw new Error('turn_limit_exceeded')

  switch (result.kind):
    'final'      →
      state.inFlightTailStart = transcript.length
      transcript = [...transcript, ...result.raw.response.messages]
      { kind: 'done', state, transcript, output: { text: result.text } }
    'tool-calls' →
      state.inFlightTailStart = transcript.length
      state.pendingToolCalls = result.toolCalls
      transcript = [...transcript, ...result.raw.response.messages]   // assistant message + toolCalls
      { kind: 'next', state, transcript, nextStep: 'dispatch-tools' }
    'stopped'    →
      state.inFlightTailStart = transcript.length
      transcript = [...transcript, ...result.raw.response.messages]
      { kind: 'done', state, transcript, output: { stoppedReason: result.reason } }

dispatch-tools:
  transcript = ctx.transcript
  while state.pendingToolCalls.length > 0:
    call = state.pendingToolCalls[0]
    r = await dispatchToolCall({
      runId, stepId: 'dispatch-tools', toolCallId: call.id,
      toolName: call.toolName, input: call.input, userId,
    })

    if r.kind === 'staged':
      // Park. Remaining tool calls re-dispatch on resume — idempotent via
      // (run_id, tool_call_id) unique on action_stagings.
      { kind: 'interrupt', state, transcript, wake: r.wake }

    // System-tool effects: pure execute returns a structured result;
    // the step body applies the effect to in-memory state, executor
    // commits it atomically with the step row.
    if call.toolName === 'system.load_integration' && r.kind === 'executed' && r.toolResult.ok:
      state.activeIntegrations = unique([...state.activeIntegrations, r.toolResult.slug])
    // future: system.spawn_sub_agent, etc.

    transcript = [...transcript, toolResultMessage(call.id, r)]
    state.pendingToolCalls = state.pendingToolCalls.slice(1)

  state.pendingToolCalls = []
  { kind: 'next', state, transcript, nextStep: 'boss-turn' }
```

**Sentinel workflow.**

```ts
// packages/api/src/modules/agent/workflows/user-authored-brief.ts
export const userAuthoredBriefWorkflow: Workflow<BriefRunState> = {
  slug: '__user-authored-brief__',     // never collides — never registered into the registry
  name: 'User-authored brief',
  trigger: { kind: 'manual' },
  initialStep: 'boss-turn',
  initialState({ brief, metadata }) {
    if (!brief) throw new Error('user-authored brief workflow requires a brief');
    const allowed = (metadata?.allowedIntegrations as readonly string[] | undefined) ?? [];
    return {
      activeIntegrations: parseIntegrationMentions(brief, allowed),
      allowedIntegrations: allowed,     // empty = unrestricted
      pendingToolCalls: [],
      inFlightTailStart: 0,
      turnCount: 0,
    };
  },
  initialTranscript({ brief }) {
    if (!brief) throw new Error('user-authored brief workflow requires a brief');
    return [{ role: 'user', content: brief }];
  },
  steps: { 'boss-turn': bossTurnStep, 'dispatch-tools': dispatchToolsStep },
};

// service.ts: `resolveWorkflowForRun` falls back here on registry miss
// only after an existence check on (userId, slug) + is_builtin=false guard.
// Typos and deleted builtins fail loud.
```

`allowedIntegrations` is threaded through `createRun.metadata.allowedIntegrations` at the call site (either `workflows.tick` or `/api/agent/runs`) so the workflow row's allowlist reaches `initialState` without a second DB read. `dispatch-tools` also passes this allowlist into `ToolExecuteContext` for `system.load_integration`; the tool returns `{ ok: false, status: 'not_allowed', slug }` instead of mutating or throwing when the slug is outside the cap.

**Transcript column.**

```ts
// packages/db/src/schema/agent.ts — agentRuns table addition
transcript: jsonb('transcript')
  .$type<AgentTranscriptMessage[]>()
  .notNull()
  .default(sql`'[]'::jsonb`),
```

One migration via `pnpm db:generate` → `db:migrate`. Default `'[]'`; no backfill (existing builtin runs don't use it). `AgentTranscriptMessage` lives in `@alfred/contracts` as a zero-dep structural alias for the subset of AI SDK messages Alfred persists; no `ai` import belongs in `@alfred/db`. The executor must load/commit this column explicitly; `agent_runs.state` remains the compact structured control state (`activeIntegrations`, `allowedIntegrations`, `pendingToolCalls`, `inFlightTailStart`, `turnCount`, etc.).

**`@`-mention parser.**

```ts
// packages/contracts/src/mentions.ts (zero-dep, importable from db + api + web)
const MENTION_RE = /(?:^|[^a-z0-9_-])@([a-z][a-z0-9_]*)/gi;

export function parseIntegrationMentions(
  brief: string,
  allowedIntegrations: readonly string[],
): IntegrationSlug[] {
  const allowed = allowedIntegrations.length > 0
    ? new Set<string>(allowedIntegrations)
    : new Set<string>(INTEGRATION_SLUGS);              // empty = unrestricted (cap-side)
  const seen = new Set<IntegrationSlug>();
  for (const m of brief.matchAll(MENTION_RE)) {
    const slug = m[1]?.toLowerCase() ?? '';
    if (!INTEGRATION_SLUGS.includes(slug as IntegrationSlug)) continue;
    if (slug === 'system') continue;                   // never user-seedable
    if (!allowed.has(slug)) continue;
    seen.add(slug as IntegrationSlug);
  }
  return [...seen];
}
```

`@skill:slug` is left alone — skill mounting lands later. Unknown slugs are ignored and never throw.

**Dispatcher autonomy override.**

```ts
// dispatch/index.ts, inside dispatchToolCall, before resolvePolicyMode
const integration: IntegrationSlug = integrationFromToolName(args.toolName);
const policyMode: PolicyMode =
  integration === 'system'
    ? 'autonomy'                                      // structural; bypass user_action_policies
    : await resolvePolicyMode(args.userId, args.toolName);
```

Audit row still lands for `system.load_integration` (and Phase 6's `system.spawn_sub_agent`); `requires_approval` is false. Scratchpad tools in Phase 6c will branch above this point into a fast-path that skips staging.

**Tool resolver.**

`AlfredAgent.tools` expects an SDK `ToolSet`; our registry holds `RegisteredTool`. The boss step builds the per-turn SDK toolset:

```ts
function resolveSdkTools(activeIntegrations: IntegrationSlug[]): ToolSet {
  const out: Record<ToolName, Tool> = {};
  for (const slug of [...activeIntegrations, 'system']) {       // system tools always present
    for (const t of listToolsForIntegration(slug)) {
      out[t.name] = tool({
        description: t.description,
        inputSchema: t.inputSchema,
        // execute intentionally omitted — AlfredAgent strips it anyway; dispatcher executes.
      });
    }
  }
  return out as ToolSet;
}
```

**System prompt skeleton.**

The preamble lives beside the sentinel workflow in `packages/api/src/modules/agent/workflows/user-authored-brief.ts` (factor it out once a second boss workflow needs it) and follows Anthropic's 10-section template (sections 1, 2, 4, 5, 8, 9 in the cache-stable system block; 3, 6, 7 flow through the message stream; 10 unused):

```
1. Task context  — "You are Alfred, the user's personal assistant agent."
2. Tone          — concise; brief reasoning before tool calls.
4. Rules         — tool families (integration tools, system tools);
                   system.load_integration to grow the toolset;
                   rejection contract (`status: 'rejected_by_user'` → don't retry identical).
5. Examples      — one short tool-call exchange + one final-summary exchange.
8. Think         — "briefly reason about your next action before calling a tool."
9. Format        — "End the run with a single user-facing summary message (no tool calls)."
```

Section 7 (immediate request) = the brief, as the first user message. Section 6 (history) = turn-by-turn `transcript`.

**Safety.**

- **Mixed staged + autonomous in one turn.** The first `dispatchToolCall` returning `kind: 'staged'` short-circuits `dispatch-tools` with `interrupt`. Successfully dispatched calls are consumed from `state.pendingToolCalls` before the interrupt commits, so resume does not append duplicate tool-result messages. The staged call and any later calls remain in `pendingToolCalls`; the `(run_id, tool_call_id)` unique index on `action_stagings` makes the staged call resume against the same row after approval.
- **Turn cap.** `state.turnCount` increments in `boss-turn`; exceeding `30` fails the run with `error.message = 'turn_limit_exceeded'`. Belt-and-suspenders against runaway loops; configurable later if needed.
- **`stopped` finish reasons.** `length` and `content-filter` map to `done` with `output.stoppedReason`; `error` and `other` map to `failed`. The History tab surfaces the reason verbatim.

**Smoke target.**

`packages/api/src/modules/agent/smoke-brief-execution.ts`:

1. Insert a `workflows` row with brief: `"@gmail — Read my most recent inbox email and summarize it in one sentence. Then tell me what's on my calendar tomorrow morning."`, `allowed_integrations: ['gmail', 'calendar']`, `is_builtin: false`, `status: 'active'`.
2. `createRun({ workflowSlug, userId, brief, metadata: { allowedIntegrations }, trigger: { kind: 'manual' } })` → `enqueueRun`.
3. Background poll: while the run isn't terminal, scan `action_stagings WHERE run_id = ? AND status = 'pending'`. For each: `UPDATE … SET status='approved', decided_at=now(), row_version=row_version+1`, then `signalRun({ runId, match: { kind: 'hil', approvalId: stagingId } })`.
4. Wait until `agent_runs.status = 'completed'` or timeout (60s).
5. Assertions:
   - `agent_runs.status = 'completed'`.
   - ≥ 2 `boss-turn` + ≥ 2 `dispatch-tools` step rows.
   - `action_stagings` has rows for `system.load_integration`, `gmail.*`, and `calendar.*`, all `status='executed'`.
   - `state.activeIntegrations` (read from `agent_runs.state`) is `{ gmail, calendar }` as a set.
   - `api_call_log` row count equals `boss-turn` step row count (ADR-0015 invariant).
   - `agent_runs.output.text` non-empty.

**Alternatives.**

- (a) **Single self-looping `agent-loop` step** instead of ping-pong. Rejected — multiple turns per step row violates ADR-0015's per-turn metering invariant; HIL interrupt mid-loop requires splitting state into "before/after dispatch," which is exactly what the second step makes explicit.
- (b) **Lazy-register a `Workflow` per user slug.** Rejected — adds per-slug registry state for no benefit; the sentinel handles everything identically.
- (c) **Transcript on `agent_runs.state.transcript`.** Rejected — state shape pollution; every step drags the full transcript through `ctx.state` regardless of whether it cares.
- (d) **Permissive `@`-mention seed (all connected integrations when no mentions).** Rejected — non-determinism across runs of the same brief, tool-definition cache thrashing across runs, surprising boss behavior. Strict + `load_integration` is more explicit and easy to relax later.
- (e) **`mutateRunState` callback on `ToolExecuteContext`.** Rejected — hidden state-write surface; couples tool internals to executor mechanics.
- (f) **`DispatchResult.stateDelta` field.** Rejected — moves system-tool knowledge into the dispatcher rather than the step body; both layers stay dumber if the step body owns the effect.
- (g) **Brief in the `system` block.** Rejected — smaller shared prefix across the user's workflows. Putting the brief in the first user message lets the system prompt be byte-identical across every brief-only run for one user, maximizing Anthropic's prefix cache hits.

**Open.**

- Whether `ai-retry` (warden's `createRetryable` pattern) wraps `getBossModel()` / `getSubAgentModel()` / `getCheapModel()` exports. Not Phase 4 — separate `@alfred/ai` refactor that affects every LLM caller.
- Phase 7 introduces the `compact-transcript` step after `dispatch-tools` when the threshold trips; the prompt and tail-selection details still get a dedicated Phase 7 pass.
- Turn cap default (30) is a guess; revisit when real runs accumulate.
- `system.spawn_sub_agent` is registered in `@alfred/contracts` but Phase 6's responsibility to implement and route through `dispatch-tools`'s step-body interpreter.
- Whether the workflow CRUD layer should reject user slugs starting with `__` to keep the sentinel namespace pristine. Defensive niceness; not blocking.
