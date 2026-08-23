# ADR-0026 — `AlfredAgent`: per-turn LLM driver, not a tool-loop wrapper

**Decision.** Roll our own thin agent class (`packages/ai/src/agent.ts`) that exposes one `turn()` method per LLM round-trip, leaving the multi-step loop to the durable runtime (ADR-0006). Do **not** subclass or compose AI SDK's `ToolLoopAgent` (formerly `Experimental_Agent`).

Concretely:

- `AlfredAgent.turn({ ctx, transcript, attribution })` resolves model + tools + system per-turn, calls `meteredGenerateText` with `stopWhen: stepCountIs(1)` and tools whose `execute` has been stripped, and returns a discriminated `TurnResult` (`final` | `tool-calls` | `stopped`). One LLM turn = one `api_call_log` row.
- The durable executor (`@alfred/api/agent`) drives the outer loop: dispatch tools, append results to transcript, schedule the next `boss-turn` step, or interrupt for HIL.
- Tools are sorted alphabetically and the last definition + the system block both get an Anthropic `cacheControl: { type: 'ephemeral', ttl: '1h' }` annotation. Same tool set across turns within a run = within-run prompt-cache hits; same integration set across runs = cross-run hits.
- `system` is captured on the first turn and **strict-pinned** by default — drift between turns throws. The reason for drift is almost always an accidentally-baked-in run id, timestamp, or feature flag, all of which silently kill the prefix cache. Set `strictSystem: false` to log a warning instead.

**Why not `ToolLoopAgent`:**

- It owns its own multi-step loop. ADR-0006/0014 require checkpoints between turns so HIL interrupts and crash-resume work; nothing inside the SDK loop can park a run.
- ADR-0015 wants per-turn cost rows. `ToolLoopAgent.generate()` returns one aggregated `totalUsage`; `onStepFinish` doesn't carry latency or `MeteredMeta`, so we can't synthesize a faithful row from inside it.
- ADR-0016's boss/sub-agent topology fans out, not loops. Sub-agent spawn is an ordinary tool call routed by the executor's dispatcher to a child `agent_runs` row — the SDK's loop hides that from the runtime.
- Lazy integration loading needs the toolset to mutate **between turns within one logical agent call**. `ToolLoopAgent.prepareCall` is per-call, not per-turn; `prepareStep` exists on `generateText` but isn't surfaced on the agent class.
- Walking the source confirms the ergonomic ceiling: `ToolLoopAgent` is ~80 LOC of settings binding (`node_modules/.../ai/dist/index.mjs:7608`), with the actual loop inside `generateText` itself. Rolling our own gives up nothing structural.

**Lazy integration loading.** The active toolset is a property on `agent_runs.state.activeIntegrations: string[]` (no separate table). Initial set = the user's connected integrations + tools implied by active artifacts at run-start (e.g. "this thread mentions a Linear issue → preload linear"). Mid-run, a `load_integration(slug)` tool call appends to `state.activeIntegrations`; the `tools` resolver re-reads it on the next turn and rebuilds the set. Cache invalidates on the load turn and rebuilds from the next.

**Sub-agent isolation.** Per dimension's pattern + ADR-0016: sub-agents receive **only the brief** as their initial transcript. No parent transcript, no shared messages. They read parent state via tool calls into the namespaced scratchpad. The dispatcher constructs the child run with `transcript: [{ role: 'user', content: brief }]` — that's the entire interface.

**No in-class compaction.** `AlfredAgent` does not summarize transcripts. If a transcript approaches the model's context window, the executor calls a separate cheap-tier `compactor` agent (Gemini 2.5 Flash) between turns to condense older messages into a `<summary>` system note, then schedules the next turn. Sub-agents don't compact at all — if a sub-agent is approaching 80% context the brief was too broad, and the right answer is to fail back to the boss for re-decomposition rather than soldier on with a degraded view.

**Not implementing the SDK `Agent` interface (yet).** The interface contract (`generate()` returns aggregated `GenerateTextResult`, `tools` is a static getter) implies a full in-process tool loop and a fixed toolset, both of which we deliberately don't have. A thin adapter can satisfy it later if SDK utilities like `createAgentUIStreamResponse` get wired into the chat surface.

**Provider scope.** `cacheControl` is Anthropic-namespaced; non-Anthropic models silently ignore it. The `cacheControl: false` escape hatch exists for agents pinned to non-Anthropic models (e.g. the Gemini compactor) where the structural overhead of the wrapped system message has no upside.

**Quirks / open questions to revisit:**

- **Provider-aware cache annotation.** Today we apply `providerOptions.anthropic.cacheControl` even when the resolved model isn't Anthropic. Wasted bytes on the wire, no correctness issue. If perf becomes a concern, gate on `model.provider.startsWith('anthropic')`.
- **`AlfredProviderOptions` type laundering.** The class types `providerOptions` as `Record<string, Record<string, unknown>>` and casts at the SDK boundary, to avoid a direct dep on `@ai-sdk/provider-utils` for one type alias. Tighten when the SDK re-exports `ProviderOptions` from the `ai` barrel.
- **Cache breakpoint count.** Anthropic allows up to 4 ephemeral breakpoints per request. We use 2 (system, last tool). Adding a third on the last _static_ user message (just before the recent-turns tail) is a future optimization once we have a compaction strategy in place.
- **Agent interface adapter.** Defer until SSE chat surface is wired (m13+). At that point either implement `Agent` directly or write a thin `toAgent(alfredAgent)` adapter.
- **Bash sandbox.** `bash` as one of the alfred-primitive tools needs a per-run ephemeral container (Docker exec or Firecracker) — host shell access is too much blast radius. Not blocking the class itself, but blocking the eventual built-in toolset; punt to its own ADR when we get to m13.
- **Read/write/edit scope.** Whether the `read`/`write`/`edit` primitives target a per-run scratchpad volume vs. user-owned notes/documents is not pinned. Default plan: per-run sandbox first (Claude-Code-shape, low stakes); user-data write paths surface as their own `notes_*` / `documents_*` tool groups loaded via `load_integration`.

**Alternatives considered:**

- (a) Wrap `agent.generate()` once in `metered()` — cheap to build, but loses per-turn rows and can't park between turns.
- (b) Subclass `ToolLoopAgent` and mete via `onStepFinish` — `onStepFinish` doesn't carry latency or MeteredMeta; partial rows; still no checkpoint per turn.
- (c) Use `generateText` with `prepareStep` for lazy loading — works for lazy tools, but the SDK still owns the loop, so HIL and crash-resume break.
- (d) **Roll our own per-turn class (chosen)** — a few hundred LOC, composes with the existing executor, every ADR constraint satisfied without surprises.

**Amendment (2026-05-22) — strict-seed `@`-mentions, not all connected integrations (ADR-0040).**

The "Initial set = the user's connected integrations + tools implied by active artifacts at run-start" line is refined for user-authored brief-only workflows. The initial `state.activeIntegrations` is `parsed @<slug> mentions in the brief ∩ workflows.allowed_integrations` (empty allowlist = unrestricted, but the parser still requires explicit `@`-mentions). An empty initial set is legitimate; the boss grows the set via `system.load_integration(slug)`. ADR-0026's "lazy integration loading" mechanism is intact — only the seed policy is refined. Rationale: determinism across runs of the same brief, tool-definition cache stability, and explicit authoring intent. See ADR-0040 for the parser shape and full reasoning.
