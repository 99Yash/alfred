# Deterministic integration loading (catalog + dispatch floor)

**Date:** 2026-06-07
**ADR:** [ADR-0053](../../decisions.md#adr-0053--deterministic-integration-loading-always-on-connected-catalog--dispatcher-enforced-auto-load-supersedes-the-prompt-only-load-instruction-of-adr-00260040)
**Trigger:** Chat `454bad3d`. A clean GitHub turn was followed by a calendar follow-up that emitted a bare `list_events` → `undeclaredToolMessage` ("Tool 'list_events' is not declared") → the boss gave up and asked the user to load Calendar (which the preamble forbids).

---

## TL;DR

Integration loading was prompt-only and probabilistic: the boss is **blind** (no tool for an inactive integration, no signal it exists), so "infer the needed integration and call `system.load_integration`" is a guess. Fix is two moves that keep lazy loading intact:

1. **Connected catalog** in the preamble — kills the blindness (names + descriptions, snapshotted at run start, cheap, cache-stable).
2. **Dispatch floor** — plain code in `dispatchToolCall` that resolves names, hard-enforces connected + allowed, and auto-activates a permitted-but-inactive integration in the same pass.

Schemas stay lazy (only *active* integrations declare full schemas). Three axes: `connected ⊇ catalog ⊇ active`.

---

## Key files

| Concern | File |
|---|---|
| Tool name types, action lists | `packages/contracts/src/tools.ts` |
| Registry (`getTool`, `listToolsForIntegration`) | `packages/api/src/modules/tools/registry.ts` |
| `system.load_integration` execute | `packages/api/src/modules/tools/system.ts` |
| Dispatcher (`dispatchToolCall`, `undeclaredToolMessage`, `integrationActionSuggestion`) | `packages/api/src/modules/dispatch/index.ts` |
| Boss preamble, `resolveSdkTools`, dispatch-tools step body | `packages/api/src/modules/agent/workflows/user-authored-brief.ts` |
| Chat preamble, `[]` seed, `applyLoadIntegrationEffect` | `packages/api/src/modules/agent/workflows/chat-turn.ts` |
| `integrationCredentials.status` | `packages/db/src/schema/integrations.ts` |
| Connected-integrations query precedent | `packages/api/src/modules/skills/context.ts:60` |

---

## Phase 1 — Connection-health helper (shared gate)

One source of truth for "is this integration usable right now?" reused by the catalog, the dispatcher, and `load_integration`.

- New helper, e.g. `integrationHealth(userId, slug): 'active' | 'needs_reauth' | 'absent'`, querying `integrationCredentials` (distinct provider + status), with the **provider→slug fan-out** for Google (one `google` credential backs `gmail`/`calendar`/`drive`/`docs`/`sheets`/`slides`). Mirror the distinct-provider query in `skills/context.ts:60`.
- Likely lives beside the registry or a small `integrations/health.ts`; must be callable from both `dispatch/` and `tools/system.ts` without a cycle.

## Phase 2 — `load_integration` validates connected + health

`packages/api/src/modules/tools/system.ts` — its `execute` checks only the allowlist cap today and returns `{ ok: true, slug }`.

- After the allowlist check, call `integrationHealth`. Return `{ ok: false, status: 'needs_connect' | 'needs_reauth', slug }` when not usable.
- The dispatch-tools step body's `applySystemToolEffect` / `applyLoadIntegrationEffect` already only activate on `ok === true`, so a failed load simply won't activate — no state change needed there.

## Phase 3 — Dispatch floor (the deterministic guarantee)

`packages/api/src/modules/dispatch/index.ts`, inside `dispatchToolCall`, before `getTool`:

1. **Name resolution.** Reuse `integrationActionSuggestion` to map a bare action (`list_events`) → qualified `ToolName`. Ambiguous bare names (today only `batch_update` ∈ `sheets`+`slides`): tie-break to the active integration, else the unique connected integration owning the action, else return `{ kind: 'ambiguous_tool', candidates }`. Key the rest of dispatch on the resolved name.
2. **Hard gating** (skip for `integration === 'system'`): `not_allowed` if outside `allowedIntegrations` (non-empty), then `needs_connect` / `needs_reauth` from `integrationHealth`. Structured results, not throws.
3. **Auto-activate signal.** If permitted + healthy but inactive, mark the slug for activation. Per ADR-0040 #5, the **state mutation happens in the dispatch-tools step body**, not in dispatch internals — so dispatch returns the activation in its result (extend `DispatchResult`, or surface via the same channel the step body reads for `load_integration`), and the step body appends to `state.activeIntegrations`.
- Add the new structured result kinds (`needs_connect`, `needs_reauth`, `ambiguous_tool`) to the dispatch result union + the tool-result message rendering so the boss sees a clean, actionable string.

## Phase 4 — Connected catalog in the preamble

- **Builder:** `buildConnectedCatalog(userId, allowed)` → the one-line-per-integration string (see ADR pseudocode), using `integrationHealth` for the `(needs reauth)` marker. Description source: a short per-integration blurb (not per-action) — keep it one line each.
- **Snapshot at run start** into `state` (e.g. `state.connectedCatalog: string`) so it is byte-stable across turns. For workflows, snapshot in `initialState`; for chat, in the run seed where `activeIntegrations: []` is set today (`chat-turn.ts:709`).
- **Render via the `system` resolver.** Change `system: BOSS_SYSTEM_PROMPT` (static) to a function returning `PREAMBLE + "\n\n" + state.connectedCatalog`. `AlfredAgent` already resolves `system` per turn; the snapshot keeps it stable so strict-pin holds. Do the same for the chat preamble.
- **Delete the blind lines:** "When a needed allowed integration is not active yet, call `system.load_integration` yourself…" (boss) and "infer the needed integration and call `system.load_integration`…" (chat). Replace with a short pointer to the catalog + the rejection/summary rules that remain.

## Phase 5 — Sub-agents + chat parity

- Sub-agents inherit the dispatch floor for free; give them a catalog scoped to their allowed set (same builder, sub-agent's `allowedIntegrations`).
- Confirm chat's cold `[]` seed now carries a real catalog and that `applyLoadIntegrationEffect` plus the new auto-activate path both feed `state.activeIntegrations` consistently.

---

## Testing

- **Reproduce the bug first** (regression target): a two-turn chat — GitHub PR count, then "list my events tomorrow morning" — must now load Calendar and answer, with **no** "not declared" and **no** "would you like me to load…".
- **Unit:** name resolution (bare→qualified; `batch_update` ambiguity tie-break); `integrationHealth` provider→slug fan-out; gating returns the right structured kind for absent/needs_reauth/not_allowed.
- **Smoke:** extend the `smoke-brief-execution.ts` pattern (ADR-0040 #8) — a brief that names a tool whose integration is connected-but-inactive should auto-activate via the dispatch floor (no explicit `load_integration` turn) and reach `executed`.
- **Cache sanity:** the catalog snapshot is byte-identical across a run's turns (strict-pin does not throw). Note all agent loops currently run on Gemini (ignores `cacheControl`), so cache *payoff* is latent until the Anthropic swap-back — verify correctness, not cache hits, for now.

## Risks / open

- **Provider→slug fan-out** is the fiddly bit — one Google credential, six service slugs. Get `integrationHealth` right or the catalog/gates misreport Google services.
- **`DispatchResult` shape change** ripples to the tool-result renderer and any History/approvals projections that switch on `kind`. Audit those switch sites.
- **Ambiguity** beyond `batch_update`: resolve lazily as collisions appear; don't pre-enumerate.
- **Mid-run connect** won't refresh the snapshot until the next run — accepted (ADR-0053 Deferred).
- **Per-tool (L3) trust** stays out of scope — orthogonal to loading.
