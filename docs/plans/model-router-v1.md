# Model router v1 — chat effort-envelope router (PRD + build plan)

> **Status.** Design grilled and locked 2026-06-22. **No code yet.** This supersedes the
> current static tier mapping (`getChatModel(tier)` / `getChatProviderOptions(tier)` in
> `packages/ai/src/provider.ts`) for the chat surface only. Recommend writing an ADR
> (next free number in [`../../decisions.md`](../../decisions.md)) before building — this
> changes how chat selects a model and amends the routing posture of
> [ADR-0065](../../decisions.md#adr-0065). The eval lane it leans on is
> [ADR-0055](../../decisions.md#adr-0055) (evalite).

Cross-references: issues **#249** (Deep over-thinks trivial queries — the proximate
trigger; the separate "started event after hydration" perceived-TTFT bug is already
fixed), **#224** (Deep silently fell to Gemini for weeks — the silent-degradation
class this design must prevent), **#216** (traces label nominal not served model —
*prerequisite*), **#193** (full-transcript replay — why mid-thread model swaps hurt),
**#223** (boss 0% prompt-cache). Relevant journal entries:
`~/journal/2026-06-20T151328Z.md`, `2026-06-21T064729Z.md`,
`2026-06-21T074846Z.md`, `2026-06-22T045121Z.md`,
`2026-06-22T084308Z.md`, `2026-06-22T121836Z.md`,
`2026-06-22T132447Z.md`. Code: `packages/ai/src/provider.ts`
(`getChatModel`/`getChatProviderOptions`/`withFallback`),
`packages/api/src/modules/agent/workflows/chat-turn.ts` (`run()`, model + providerOptions
selection ~617–627), `apps/web/src/routes/-chat/model-tier-picker.tsx` (the Auto/Deep
picker), `api_call_log` (records the *served* model — the data source for observability).

---

## 1. Why — the thesis

The composer's Auto/Deep picker today is a **static model selector in disguise**: `Auto →
Sonnet 4.6 @ low effort`, `Deep → Opus 4.8 @ high effort`. Two problems:

1. **It over-serves.** Deep pins `effort: "high"`, so a trivial turn ("what's in this
   image", "is my 3pm free") burns seconds of extended thinking for zero quality gain
   (#249).
2. **It asks the user to manage models.** Frontier models ship every couple of weeks.
   Making the end user track which model fits which task is a tax that only *developers
   building coding tools* should pay. Alfred is a single-user personal assistant; the
   chat persona is "ask my assistant," not "pick an engine."

**The thesis (reframed during the grill):** the router is **not** a query-difficulty
classifier. Its real job is to be the **one seam that absorbs model churn** so the user —
and the rest of the codebase — never feels a model swap. "Auto" and "Deep" stop being
models and become an **effort envelope**: *how much the turn is authorized to spend to
answer well.* Model identity becomes an internal lever, not a user choice.

### Reconciling the standard critique of model routers

A senior engineer's critique (paraphrased): routers are over-hyped, they break feedback
loops, they fight prompt cache, and "knowing your model is a skill." Each is true of a
*bad* router and is defeated here by construction:

| Critique | How v1 defeats it |
|---|---|
| "Knowing your model is a skill." | True for coding tools; weak for a single-user assistant. We still preserve the lever (Deep) and full retrospective visibility (the activity table). |
| "Routers break the feedback loop." | The observability table (served model + mode + cost + latency) + the Deep override **are** the loop. Hiding the model is only safe *because* what ran is visible. |
| "Prompt cache limits routing." | We never swap **model** mid-thread (sticky escalation-only); only **effort + tool-loop** vary per turn, and those are request params / loop counts that don't invalidate the cached prefix. |
| "Effectiveness is exaggerated." | We don't build a speculative classifier. Self-routing rides the answering model's own first move (zero extra call), and a labeled eval lane proves it earns its keep. |

---

## 2. Non-goals (v1)

- **Not a separate classifier call.** No cheap-model or Opus pre-flight gate. (Rejected:
  adds latency-before-first-token to *every* turn — that *is* #249, one layer up.)
- **Not cross-model routing mid-thread / mid-stream.** [ADR-0065](../../decisions.md#adr-0065)
  already rejected per-turn model routing because transcript replay (#193) pins a thread
  to a provider. v1 honors that: model is sticky per-thread.
- **Not system-wide.** Governs the **chat surface only** (`getChatModel`/
  `getChatProviderOptions` + the chat tool-loop). Boss (`getBossModel`), the sub-agent
  dispatcher (ADR-0016/0026), triage, and briefing keep their current explicit selection.
  *The registry module is built standalone so they can adopt it later without a rewrite.*
- **Not sub-agent fan-out control.** The "spawn sub-agents to go deeper" lever is deferred
  (filed as a fast-follow issue).
- **Not auto model-escalation under Auto.** In v1 only explicit Deep jumps the model;
  Auto auto-escalating Sonnet→Opus is a documented fast-follow.
- **Not attachment-hydration latency.** The image-upload journal found two TTFT causes:
  "started" was emitted after transcript hydration (fixed) and Deep over-thought trivial
  image turns (#249). This plan handles the model-effort side only; serial historical
  image hydration stays a separate optimization if it reappears in traces.

---

## 3. The model — locked decisions

The router's output is **not "a model"** — it is an **effort envelope** (a budget the turn
may consume), of which model identity is one lever.

| # | Decision | Choice |
|---|---|---|
| 1 | **Scope** | Chat surface only; registry built standalone for later reuse. |
| 2 | **What the picker means** | Auto/Deep = an *effort envelope* (authorization), not a model. Model identity is internal. |
| 3 | **Envelope levers (v1)** | Model tier · thinking/reasoning effort · tool-loop / agentic depth. (Fan-out deferred.) |
| 4 | **Ceiling, not mandate** | Effort intent *caps* spend; it never forces it. Deep on a trivial turn still answers directly. This is the #249 fix. |
| 5 | **Routing mechanism** | **Self-routing** — the answering model decides direct vs research-mode as its first move. No separate classifier. |
| 6 | **Model cadence** | **Sticky per-thread, escalation-only.** Never flaps down within a thread. |
| 7 | **Effort + tool-loop cadence** | **Per-turn, self-routed.** Cache-safe (not part of the cached prefix). |
| 8 | **Model-jump trigger (v1)** | **Explicit Deep only.** Auto ramps effort + tool-loop on the current model; never swaps it. |
| 9 | **Deep persistence** | **High-water mark.** Deep ratchets the thread floor to Opus permanently; later Auto turns stay ≥ Opus (effort may relax, model won't drop). Reset = new thread. |
| 10 | **Gate signal** | **Hybrid.** Direct path just answers (mode derived). Research path first emits a one-line plan/rationale (mode + why) → feeds the table, the eval label, and a live "what I'm digging into" line. |
| 11 | **Observability** | A settings **model-activity table** (dimension's surfacing pattern, Alfred's own), backed by `api_call_log`. Deep is the live override. |
| 12 | **Eval** | **Labeled gate eval** on evalite; fixtures mined from `api_call_log` + real threads; deterministic mode-match scorer first, LLM-judge only at boundaries. |
| 13 | **Thread model pin** | Sticky means a concrete primary model id/registry version is captured on the thread. Storing only `standard`/`deep` would make old threads silently move when the registry changes, violating the cache/replay premise. |

### The two-cadence insight (the spine of the whole design)

Prompt cache keys off **prefix content** (system prompt + transcript) and the provider-side
model namespace. Therefore:

- **Model identity → sticky per-thread.** Switching it re-primes the cache and #193 replay
  makes that bite every later turn. So it only ever ratchets up, once, and stays. This
  includes registry churn: new threads can use a new "Auto" model, but existing threads
  keep their pinned primary unless the user explicitly starts a new thread or escalates.
- **Effort + tool-loop → free to vary every turn.** They're request params / loop counts,
  not cached prefix content. This is where ~all the per-turn right-sizing lives. The
  system prompt must contain both direct/research instructions from the start; do not
  rewrite the system prompt per mode, or the cache win disappears.

### Picker semantics (final)

- **Auto** = "router picks the effort; use the thread's current model floor."
- **Deep** = "raise the bar — more authorization this turn, and ratchet the model floor to
  Opus for the rest of the thread."
- **New thread** = reset to the Auto/Sonnet floor.

---

## 4. Mechanism — how a turn flows

```
turn arrives (picker tier rides with the send, as today)
  │
  ├─ primary model = thread.pinned_primary_model ?? registry.autoPrimary
  │    └─ if tier==deep and floor<deep, pin registry.deepPrimary on the thread
  │
  ├─ effort ceiling = tier==deep ? high : low/medium                          # per-turn, cache-safe
  │
  └─ run AlfredAgent on the selected model:
       first LLM round — self-route at conservative/default effort:
         • trivial/answerable now → answer directly         (mode='direct', derived)
         • benefits from going far → emit one-line plan,     (mode='research', declared)
           then take a tool/continuation path
       later LLM rounds in the same run:
         • if mode='research', raise effort + tool-loop UP TO the ceiling
       (model never changes inside the run; providerOptions change only on later requests)
```

- **Thread state addition:** a persisted per-thread semantic floor *and* concrete pinned
  primary model (or equivalent registry-version pin). Today `getChatModel(state.tier)` is
  recomputed per turn from the send's tier; v1 must make the primary model a thread fact.
  A fallback-served model (Gemini during an Anthropic blip) does **not** become the pin.
  Only an explicit Deep ratchet changes the floor. The ratchet should happen in the same
  transaction/lock window as run creation so two sends from different devices cannot race
  a Standard turn through after a Deep ratchet.
- **Provider-options reality:** AI SDK provider options are fixed for one `streamText`
  request. "Ramp effort mid-turn" therefore means "on the next `chat-turn` step after the
  gate/tool result," not "change Opus from low→high inside an already-open stream." If a
  research-worthy turn needs high reasoning without any external tool, add a cheap
  sentinel/continuation path so the final answer is produced in a second LLM round.
- **Tool-loop ceiling:** a bounded max number of tool rounds per turn, config-tunable, with
  `direct` and `research` defaults (e.g. direct ≤ 2 rounds, research ≤ N). The envelope
  enforces the ceiling regardless of what the gate declares.
- **The research plan** renders in the existing run/thinking disclosure — doubles as UX for
  slow turns ("Pulling the last week of activity on this project…").
- **Mode derivation:** `declared_mode='research'` only if the model emits the structured
  one-line plan/sentinel. `observed_mode` can also be inferred from tool rounds or the
  sentinel continuation. Persist both so evals can catch "declared research, behaved direct"
  and the reverse.

---

## 5. Observability — the feedback loop

**A settings "model activity" table**, borrowing dimension's surfacing pattern
(`MODEL_DISPLAY_NAMES` map + frosted `<table>`) and
**none** of their routing logic. Built as Alfred's own thing.

- **Data source:** `api_call_log` records the **served** model for successful calls (the
  withFallback attribution from the #224 fix). The table is a read-only server query over
  existing telemetry; expose it via an API/contract DTO so `apps/web` never imports DB or
  server packages.
- **Instrumentation contract:** chat LLM calls must write enough metadata to make the table
  honest: `messageId` (currently omitted on chat calls), `threadId` in `request_meta`,
  requested tier, pinned primary model, floor before/after, effort ceiling, actual effort
  sent, tool-loop ceiling, declared/observed mode, and fallback/served-model evidence. For
  failed calls, `api_call_log` may only know the nominal pre-call model if no provider
  response exists, so #216 should include fallback-attempt visibility rather than relying
  solely on `response.modelId`.
- **Columns:** per turn/thread → requested tier · pinned primary · served model · declared
  and observed mode · effort · tool rounds · tokens/cost · latency · error/fallback state.
  This is where a silent Gemini fallback (#224) or a model swap becomes *visible* instead
  of festering.
- **Scope asymmetry (intentional):** the *router* is chat-only, but the *table* can show
  **all** model activity (chat, triage, briefing, boss) once the non-chat callers also
  plumb `role`/surface metadata. Until then, all-surface rows are useful but coarser.
- **Live override stays the Deep button** (re-ask with more authorization). Table =
  retrospective loop; Deep = in-the-moment loop.
- **Prerequisite:** #216 (served ≠ nominal in traces) must be fixed first, or the table
  lies.
- **Fast-follow (not v1):** a *loud* signal — flag a thread when fallback-rate or cost
  spikes — because a table you must *visit* is passive, and passivity is exactly why #224
  stayed silent for weeks.

---

## 6. Eval contract

Labeled **gate eval** on the existing evalite lane (ADR-0055):

- **Fixtures:** real chat turns mined from `api_call_log` + `chat_messages`/run state +
  hand-picked own threads, labeled `direct` vs `research-worthy`. `api_call_log` alone
  is a cost ledger, not a full prompt dataset; use it to locate candidate turns and join
  to chat/run records for the actual transcript and mode metadata. Lead with the rubric
  (principles-over-exemplars house style); exemplars only at the boundary.
- **Scorer:** deterministic mode-match first (did the gate's chosen mode equal the label?).
  LLM-judge only for ambiguous boundary turns.
- **What it protects:** a model swap (churn) silently shifting gate behavior; the gate
  drifting toward over- or under-serving. Re-run when a new model is slotted into the
  registry — this *is* the churn-defense.
- **Not in v1:** outcome eval (replay at both effort levels, judge which sufficed) — heavier
  and judge-dependent; file as a follow-up if gate-match proves insufficient.

---

## 7. Failure modes & mitigations

- **Trivial-looking but actually subtle** ("summarize this — am I being scammed?"): the gate
  may wrongly pick `direct`. Mitigations: (a) Deep button as explicit user escalation;
  (b) the gate decision is low-stakes-reversible — the model can still ramp effort mid-turn;
  (c) the eval fixture set deliberately includes these.
- **Sticky Opus cost** (decision #9): a thread that went Deep stays Opus even for trivial
  follow-ups. Accepted tradeoff for cache stability + simplicity; reset = new thread; the
  activity table surfaces the cost so it's never invisible.
- **Gate declares research but underdelivers / vice-versa:** mode is hybrid-derived, so the
  table can show *declared* vs *observed* divergence; eval catches systematic drift.
- **Provider blip mid-stream:** unchanged from today — `withFallback` only covers
  pre-stream errors (documented streaming caveat in `provider.ts`).
- **Registry update breaks stickiness:** if `model_floor='standard'` is the only thread
  state, a registry update silently moves old threads to a new model. Mitigation: pin the
  concrete primary model/registry version on the thread; new registry defaults apply only
  to new threads.
- **Research ramp cannot happen inside one stream:** provider options are immutable for a
  single SDK request. Mitigation: make research mode transition the durable run state and
  apply higher effort only on subsequent `chat-turn` requests.
- **Passive observability repeats #224:** a settings table still requires the user to look.
  Keep the table in v1, but file the loud fallback/cost-spike signal immediately after it,
  not as an indefinite "nice to have."

---

## 8. Build sequence (phased, ordered)

**Phase 0 — prerequisite.** Fix **#216** (log/trace the *served* model, not the nominal)
and add the chat telemetry contract above (`messageId`, `threadId`, requested tier, floor,
effort, mode, fallback evidence). The activity table and eval both depend on truthful
served-model and mode data.

**Phase 1 — the #249 thin edge (ships alone, no new infra).** Make Deep's effort a
*ceiling directionally, not the full router yet*: de-pin `getChatProviderOptions("deep")`
from unconditional `effort: "high"` so trivial turns stop over-thinking. Without
self-routing this is not a true per-turn ceiling yet; it is a conservative default that
isolates the latency win before the gate exists. Acceptance: a trivial Deep vision/text
turn is no longer forced into high-effort thinking, the "started" indicator appears before
hydration, and telemetry records TTFT/reasoningMs/cost for comparison. Do not promise ~1s
until measured on the actual Opus/Sonnet path.

**Phase 2 — registry + envelope.** Standalone churn-absorption module: current-best
{cheap, deep} mapping + the envelope type (model tier · effort ceiling · tool-loop ceiling).
`getChatModel`/`getChatProviderOptions` become thin readers of it. Add the thread schema
migration for semantic floor + concrete pinned primary model/registry version. Seed existing
threads conservatively from their current default; new threads pin on first send.

**Phase 3 — self-routing + sticky escalation.** Wire the hybrid gate into `chat-turn.ts`
(system-prompt guidance for direct-vs-research; research emits a one-line plan into the run
disclosure). Apply pinned model/floor selection, persist floor on Deep, carry mode in
`ChatRunState`, and raise effort/tool-loop ceilings only on later `chat-turn` requests after
research mode is declared.

**Phase 4 — observability table.** Settings model-activity table over `api_call_log`
(dimension surfacing pattern, Alfred's own).

**Phase 5 — eval lane.** Labeled gate fixtures + deterministic mode-match scorer on evalite.

**Build rule:** Phase 1 must ship and verify the #249 acceptance before Phase 3 adds the
gate, so the latency win is isolated from the routing change.

---

## 9. Deferred — file as issues

- **Auto model auto-escalation** (Sonnet→Opus under Auto without an explicit Deep), via
  next-turn escalation (decision #8 alternative).
- **Sub-agent fan-out** as a fourth envelope lever (decision #3).
- **Loud degradation signal** (fallback-rate / cost-spike alert) beyond the passive table.
- **Attachment hydration parallelization** if traces still show historical image reads in the
  critical path after the model-effort fix.
- **Outcome eval** (replay-at-both-efforts) if gate-match scoring proves insufficient.
- **Adopt the registry system-wide** (boss / dispatcher / triage / briefing).

---

## 10. Open questions for the ADR

1. Exact tool-loop ceilings (`direct` vs `research`) — start conservative, tune via eval.
2. Effort ceiling values: is Auto `low` or `medium`? (#249 suggests Auto should still
   self-size via adaptive thinking, so likely `low` ceiling + adaptive.)
3. Pin shape: concrete `pinned_primary_model` column, registry-version column, or a compact
   `router_state` jsonb? Default recommendation: explicit typed columns on `chat_threads`;
   run metadata alone cannot affect future turns.
4. Does the research plan-line persist (jsonb segment, like interleaved narration) or render
   ephemerally?
5. What is the sentinel/continuation shape for research-worthy turns that need high reasoning
   but no external tool?
