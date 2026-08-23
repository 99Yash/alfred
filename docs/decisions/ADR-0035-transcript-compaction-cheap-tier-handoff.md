# ADR-0035 — Transcript compaction: cheap-tier handoff summary at 60% threshold

**Decision.** When a boss run's transcript token-count exceeds 60% of the resolved model's context window, the executor inserts a dedicated `compact-transcript` step between `dispatch-tools` and the next `boss-turn`. The step calls a cheap-tier compactor (`getCheapModel()`) to produce a structured XML **run handoff** that replaces older transcript messages while preserving the in-flight tail (most recent assistant message + its tool calls + their results). The stable boss system prompt and tool definitions remain outside `agent_runs.transcript` as `AlfredAgent.turn()` inputs. The handoff captures `goal`, `user_directives`, `decisions`, `actions_completed`, `actions_rejected`, `actions_failed`, `sub_agent_findings`, `pending_followups`, `key_entities`. Sub-agents do not compact — they fail back to the boss for re-decomposition (ADR-0026).

**Why.**

- **Quality, not headroom.** Long-context quality degrades materially before the hard limit (200K-window models around 120-150K; 1M-window models around 400-600K — empirically observed across both Claude and Gemini families). Compacting at 60% keeps the working window in the high-quality region rather than chasing token-counting efficiency. Cost differential of more frequent cheap-tier calls is negligible at single-user scale; quality difference is not.
- **No verbatim "last N" preservation.** A 30K-token tool result in the recent tail would defeat compaction's purpose. The minimum the boss needs to continue mid-step is system + tools + the immediately-prior assistant message and its tool results — the in-flight tail. Everything older compresses into the handoff.
- **XML over JSON for the handoff.** Anthropic explicitly recommends XML for nested-structure prompts; the model parses sections more reliably; less syntax noise per token on tool-call records. Schema is fixed (compactor's job is to fill slots), not free-form (which would lose structure across compactions).
- **Cheap-tier compactor, structurally bounded.** `getCheapModel()` (Haiku 4.5 / Gemini 2.5 Flash via the ADR-0016 dispatcher); output capped at 2000 tokens. Each `<action>` becomes one short line — IDs and outcomes kept, narrative dropped.
- **Distinct executor step, not inline.** Compaction is state management, not a tool call. Putting it in the executor between `dispatch-tools` and `boss-turn` makes it a real checkpoint (durable-resume compatible) and keeps `AlfredAgent.turn` free of compaction concerns. Also preserves ADR-0015's "one LLM round-trip = one `api_call_log` row" — the compactor is its own metered call with `attribution.role='compactor'`.

**Run handoff schema.**

```xml
<run_summary>
  <goal>One-line restatement of what this run is trying to accomplish.</goal>

  <user_directives>
    <!-- Mid-run intent statements that bound the agent's future behavior:
         scope grants, integration trust changes, redirections.
         Verbatim, not paraphrased. Pragmatic, not epistemic. -->
    <directive>e.g. "User said 'trust gmail entirely for this conversation' at turn 3."</directive>
  </user_directives>

  <decisions>
    <!-- Facts, preferences, or constraints learned during the run. Epistemic. -->
    <decision>e.g. "Alice is the engineering manager (confirmed via signature in thread #42)."</decision>
  </decisions>

  <actions_completed>
    <action tool="gmail.search" key_output="found 3 threads from alice@..." />
  </actions_completed>

  <actions_rejected>
    <action tool="gmail.send_draft" reason="user said 'already replied to this thread'" />
  </actions_rejected>

  <actions_failed>
    <action tool="..." error="..." />
  </actions_failed>

  <sub_agent_findings>
    <finding sub_id="sub_a" key_output="..." />
  </sub_agent_findings>

  <pending_followups>What the boss said it would do next.</pending_followups>

  <key_entities>
    <entity name="Alice" id="alice@..." context="manager; brought up in 3 threads" />
  </key_entities>
</run_summary>
```

**`<user_directives>` is the load-bearing slot.** Without it, mid-run policy changes ("just trust gmail for the rest of this conversation") evaporate after the next compaction and the boss starts re-asking for approval. ADR-0034's forward-compat `set_action_policy` tool will eventually persist these to `user_action_policies` properly; until then, the handoff carries the directive forward within the run. The distinction between `<user_directives>` (pragmatic — what the user wants) and `<decisions>` (epistemic — what's true) matters because the boss reasons differently about each: directives bound behavior, decisions bound belief.

**Executor flow.**

```
boss-turn (proposes tools)
  → dispatch-tools (results land in transcript)
    → executor measures tokenCount(agent_runs.transcript)
       if tokenCount > compactionThresholdTokens(model.contextWindow):
         → compact-transcript
            ├── identify in-flight tail (`state.inFlightTailStart` → transcript end)
            ├── invoke cheap-tier compactor with prior transcript
            ├── compactor emits <run_summary>
            └── rewrite agent_runs.transcript to [<summary>, in-flight tail]
       → boss-turn (consumes results / summary)
```

In-flight tail identification rule: `boss-turn` records `state.inFlightTailStart = transcript.length` immediately before appending the assistant message/tool calls for that turn. `compact-transcript` preserves `transcript.slice(state.inFlightTailStart)` verbatim and feeds everything before it to the compactor. Deterministic, bounded by one iteration's worth of messages, and does not require per-message metadata.

**Compactor invocation contract.**

```ts
const result = await meteredGenerateText({
  model: getCheapModel(),
  attribution: { kind: "llm", role: "compactor" }, // per m13 plan
  maxOutputTokens: 2000,
  system: COMPACTOR_SYSTEM_PROMPT,
  messages: priorTranscriptToCompact,
});
nextTranscript = [
  { role: "system", content: `<run_summary>${result.text}</run_summary>` },
  ...inFlightTail,
];
```

`COMPACTOR_SYSTEM_PROMPT` (sketch, subject to prompt-engineering pass): "Summarize the transcript below into the schema. Maximum 2000 tokens. Drop verbatim text; keep IDs, decisions, user directives, every approved/rejected/failed action with its outcome, every sub-agent finding. **Preserve mid-run user intent statements verbatim under `<user_directives>`; do not paraphrase.** Each `<action>` is one short line."

**Cache interaction.**

ADR-0026's two ephemeral `cacheControl` breakpoints sit on the stable system prompt and the last tool definition; both survive compaction because they are supplied outside `agent_runs.transcript`. After compaction, place a **third** ephemeral breakpoint immediately after the `<run_summary>` system note in the transcript. Anthropic allows up to 4 breakpoints per request (ADR-0026 footnote explicitly called out compaction as the trigger to use the third).

- Immediate next turn after compaction = cache miss on the message-history portion. Expected; the alternative is context-overflow failure.
- Subsequent turns hit the new stable prefix (system + tools + `<summary>`). Each new turn appends to the in-flight tail, hitting the cache up through the summary breakpoint.
- Next compaction invalidates the third breakpoint; cycle continues.

**Implementation notes.**

- **`model_prices.context_window`** column added. Seeded from `models.dev` by `pnpm --filter @alfred/db db:sync-prices` (ADR-0016). The executor resolves `model.contextWindow` from this column rather than hardcoding per-SKU.
- **Token counting** uses AI SDK's tokenizer (or `@anthropic-ai/tokenizer` for Anthropic models). Approximation within ~5% is acceptable for threshold purposes — we have 5% slack on either side of the 60% boundary.
- **Threshold constant** lives in `@alfred/contracts`:
  ```ts
  export const COMPACTION_THRESHOLD_PCT = 0.6;
  export const compactionThresholdTokens = (modelContextWindow: number) =>
    Math.floor(modelContextWindow * COMPACTION_THRESHOLD_PCT);
  ```

**Fault behavior.** Compactor call failure triggers a **bounded in-step retry** — 3 attempts with 100ms then 200ms backoff inside the `compact-transcript` step body. On terminal exhaustion the run fails with `error.message='compactor_failed: <last error>'`. Explicit failure beats degraded behavior (running with overflowing context = hallucination or silent truncation). The retry lives in the step rather than relying on the executor's per-attempt counter so a transient cheap-tier blip doesn't burn a whole run attempt; the executor's idempotency (per ADR-0014) still covers worker-crash recovery, narrowing the double-charge window to a single in-flight cheap-model call (~$0.0001) — matching every other LLM step in the system. Three local attempts is also enough headroom that persistent failure surfaces as a real bug rather than a flapping retry loop. **Per-run dollar budget for runaway loops is the orthogonal concern handled by ADR-0046** (sibling, deferred from m13); the 30-turn cap in `userAuthoredBriefWorkflow` is the structural ceiling in the meantime.

**Sub-agents do not compact.** Per ADR-0026, a sub-agent approaching its context window is evidence the brief was too broad; the right answer is failing back to the boss for re-decomposition, not soldiering on with a degraded view. No compactor invocation inside a sub-agent run. The boss's own "compaction" of sub-agent output happens at the scratchpad/`promote` boundary per ADR-0016 — that's a different mechanism (synthesis at the agent-tree edge) than transcript compaction (in-flight reduction within a single agent's context).

**Alternatives.**

- (a) **In-run compaction at 80% threshold (Dimension's value).** Rejected — long-context quality degrades materially earlier; 60% keeps the working window in the high-quality region. Empirical, not theoretical.
- (b) **Preserve "last N message pairs" verbatim alongside the summary.** Rejected — a 30K-token tool result in the recent tail defeats compaction. The in-flight tail is bounded by one iteration's worth of work; "last N pairs" is unbounded.
- (c) **JSON schema for the handoff.** Rejected — Anthropic recommends XML for nested-structure prompts; XML parses more reliably across long structured sections; less syntax noise per token on tool-call records.
- (d) **Inline compaction inside `AlfredAgent.turn`.** Rejected — conflates LLM concerns with state management; breaks durable-resume; violates ADR-0015's "one LLM round-trip = one `api_call_log` row" (compaction would silently happen inside a single charge-and-log boundary).
- (e) **Cost-triggered compaction** (e.g. compact when run spend exceeds $X). Rejected for v1 — orthogonal concern (budget enforcement, not quality preservation). The `model_prices.context_window` column gives us the hook for a richer trigger later if needed.
- (f) **Post-run conversation summary** (Dimension's platform-specific thresholds). Deferred — no long-lived chat surface yet at Alfred v1; revisit when the composer (post-m13) ships substantial user conversations worth preserving across runs.

**Open.**

- The compactor system prompt is sketched, not engineered. A real prompt pass with long runs to test against lands with m13a.
- 2000-token output cap is a v1 guess. Worth dialing once real runs accumulate.
- Whether the boss's own system prompt should include explicit guidance to restate received user intent as future-compaction-friendly directives ("when the user expresses an intent that bounds your future behavior, restate it succinctly so it survives compaction"). Leaning yes; lands with the boss system prompt design in m13a.

**Amendment (2026-06-01) — compactor decoupled from `getCheapModel()` to Sonnet 4.6 (thinking off); threshold uses `min(boss, compactor)` window.**

The 7f prompt-engineering pass forced the compactor's model identity, which surfaced two issues the original ADR glossed.

- **Model: Claude Sonnet 4.6, extended thinking disabled** (`providerOptions.anthropic.thinking: { type: 'disabled' }`). The ADR body and `compactor.ts` used `getCheapModel()` (today `gemini-2.5-flash-lite`). Reconsidered against the compactor's actual profile: it fires _rarely_ (only past threshold), is _latency-tolerant_ (a background mid-run step), and is _quality-critical_ (a botched handoff corrupts the entire remainder of the run). On that profile cost and speed are nearly free axes; the only axis that matters is structured-output + instruction-following reliability — exactly where flash-lite is weakest (Artificial Analysis Intelligence Index ~13; the `assertRunSummary` code-fence-tolerance hack is direct evidence it fights the envelope). Sonnet 4.6 leads on instruction-following / verbatim discipline; thinking is disabled because the compactor is a mechanical transform, not a reasoning task, so thinking tokens are pure waste. A compaction costs cents regardless, so the ~3× price over Haiku and the latency delta are immaterial. **Not a new tier dispatcher** (no `getCompactorModel()`): the model is a shared `COMPACTOR_MODEL` constant, imported by both the compactor call and the threshold math (which needs the compactor's window).
- **Fallback: Gemini 2.5 Flash** (II ~27, 1M context), _not_ flash-lite. Flash-lite (II ~13) is below the acceptable quality floor for the handoff. Flash's 1M window also means it never _shrinks_ `min()` (below), so it doubles as the overflow-escape route.
- **Threshold = `compactionThresholdTokens(Math.min(bossWindow, compactorWindow))`**, both windows resolved from `model_prices.context_window`. The body's `compactionThresholdTokens(model.contextWindow)` read only the boss window. That breaks the moment the compactor's window is smaller than the boss's — which is true _right now_: during the provider-swap window the boss is `gemini-2.5-pro` (1M → 600k threshold) while the compactor is Sonnet (200k). A 600k prior slice cannot be ingested by a 200k model. `min()` is therefore unconditional, not GPT-conditional. Applied at **both** call sites in `userAuthoredBriefWorkflow`: the pre-compaction trip-wire and the post-compaction Guard 3 overflow check (the latter previously thresholded on the boss window, which let a large in-flight tail pass and then overflow the compactor one turn later).
- **New pre-call guard: prior slice must fit the compactor window.** Before invoking the compactor, estimate `priorTokens`. If `priorTokens > compactorWindow`, escalate to `COMPACTOR_FALLBACK_MODEL` (Gemini Flash, 1M); if it exceeds even the fallback window, fail with `compactor_input_too_large`. This directly asserts the ingest invariant rather than trusting the threshold math, and covers the pathological case where a single high-payload turn's in-flight tail becomes `prior` on the next turn. Tiered (fallback → fail) beats a flat fail: accept one lower-quality compaction to survive rather than killing the run.

This supersedes the `getCheapModel()` references for the compactor throughout this ADR and resolves the first "Open" item's model question. The in-flight-tail rule, the `<user_directives>`-verbatim contract, the third cache breakpoint, and the bounded-retry fault model are all unchanged.

**Schema addition — directive supersession.** `<directive>` gains an optional `superseded="true"` attribute. The body said "preserve every mid-run user intent statement verbatim," which, taken literally, retains both a directive and its later revocation with no signal which is current — so the boss can act on revoked permission. New contract: keep every directive verbatim in chronological order; when a later directive conflicts with / overrides an earlier one, tag the earlier with `superseded="true"`. The marker is metadata, so "verbatim" still holds (the quote text is untouched); the boss acts only on non-superseded directives. Nothing is dropped (audit intact) and a revoked _intent_ is **not** demoted to `<decisions>` (it isn't an epistemic fact). Proven by the `superseded-directive` fixture (m13 Phase 7f).

**Fault model addition — overflow is not the same as failure.** Two distinct paths: a compactor _call_ failure (model error / invalid envelope) takes the existing bounded retry → `compactor_failed`; a _prior-slice-too-large_ condition first falls over to `COMPACTOR_FALLBACK_MODEL` (1M window) and only fails with `compactor_input_too_large` when the slice exceeds even the fallback. The latter is the single place a degraded (lower-quality) compaction is accepted — surviving a pathological high-payload turn beats killing the run. This refines the body's blanket "no degraded fallback" line, which predated the asymmetric-window reality.

**Amendment (2026-07-11) — persisted chat compaction resolves alternative (f).**
Substantial composer conversations now exist, and #370 demonstrated the deferred reliability
cliff: chat replays unbounded persisted history and otherwise discovers overflow through a
provider failure. Chat therefore gains a distinct, provenance-backed
`<conversation_summary>` plus compound message watermark, a token-budgeted verbatim tail,
background-first compaction, an honest synchronous pre-call backstop, and within-run tool-loop
compaction. The summary is historical user-role context—not a boss `<run_summary>` and never a
system instruction—and raw messages/tool records remain recoverable through bounded on-demand
history retrieval. Background compaction starts at
`min(60% of the effective window, 200_000 tokens)`; synchronous safety acts at 85% after the
actual system/tool/transcript shape and explicit output reserve are accounted for. Chat
compaction manages working context only and remains separate from chat-memory extraction and
durable user-memory projection. Historical media is normalized by a shared, capability-routed
enrichment worker; attachment modality never swaps the sticky answering model. Full decision
and test contract: [chat-compaction-and-overflow-v1.md](../plans/chat-compaction-and-overflow-v1.md).
