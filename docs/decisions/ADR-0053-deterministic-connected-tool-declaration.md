# ADR-0053 — Deterministic connected tool declaration + dispatch-enforced gates; supersedes the prompt-only load instruction of ADR-0026/0040

**Decision.** The agent no longer relies on the model _inferring_ when, and which, integration to load. The prompt-only instruction ([ADR-0040](#adr-0040) #6, mirrored in the chat preamble) is the bug: the boss is blind when an integration is inactive, so it can emit a bare action such as `list_events`, receive "Tool 'list_events' is not declared", and then ask the user to load Calendar. Observed in chat `454bad3d`.

The v1 fix is deliberately simpler than the original lazy-loading design:

1. **Declare connected ∩ allowed tools eagerly at run start.** The current real surface is small and code-controlled (Gmail, Calendar, Drive, Docs, Sheets, Slides, GitHub; Slack/Linear/iMessage are empty stubs). Declaring those full schemas gives the model the argument contracts immediately and removes the mid-conversation load round trip.
2. **Keep a connected summary in the system preamble.** A frozen, one-line-per-integration summary (`slug — actions — short desc`, with health markers) remains useful grounding and exact-slug copy, but it is no longer the only way the boss learns tools exist.
3. **Make the dispatcher the security floor.** `dispatchToolCall` must resolve bare/qualified names and hard-enforce `allowed_integrations` + scope-aware connection health before any registered non-system tool can execute. This closes ADR-0043's exposure-only hole: qualified calls cannot bypass the declared-tool surface.

Lazy catalog + `system.load_integration` + dispatcher auto-activation is deferred. It is a future optimization only if the connected schema surface becomes materially large; v1 should not pre-pay that complexity while N is small.

**Micro-decisions.**

1. **Eager connected declaration.** At run start, compute usable integrations as connected ∩ allowed ∩ non-empty-action slugs. Seed `agent_runs.state.activeIntegrations` with that set, and let the existing `resolveSdkTools` path declare their full schemas every turn. Empty `allowed_integrations` means unrestricted among connected loadable integrations; non-empty remains a hard cap. The old strict `@`-mention seed remains historical ADR context and can become a future hint for lazy mode, but it is not the v1 declaration boundary.

2. **Connected summary is frozen grounding copy.** Snapshot a short connected summary into run state at creation. The `AlfredAgent` `system` resolver may concatenate that frozen string with `BOSS_SYSTEM_PROMPT`, `CHAT_SYSTEM_PROMPT`, or `SUB_AGENT_SYSTEM_PROMPT`, but it must not perform live DB/health reads during a turn. This is cache-stable by construction; the old strict-pin runtime check is not a cross-turn backstop because agents are rebuilt per step.

3. **Scope-aware health is first-class.** `integrationHealth(userId, slug)` is not just `integrationCredentials.status`. For Google-backed slugs it must also check the scopes required by that slug (`gmail`, `calendar`, `drive`, `docs`, `sheets`, `slides`). A Calendar-only Google credential makes Calendar usable but does not make Sheets usable. With multiple Google rows, reduce to: any active row with required scopes wins; otherwise a relevant but unhealthy/insufficient row reports `needs_reauth`; otherwise `needs_connect`. Treat any non-`active` row status as unusable.

4. **Dispatch name resolution happens before the `isToolName` guard.** Bare actions such as `list_events` resolve to a qualified `ToolName` before `getTool`. Ambiguous actions such as `batch_update` return a structured `ambiguous_tool` result rather than guessing. The resolver should distinguish three outcomes: unknown, qualified, ambiguous.

5. **Dispatch hard gate.** For every resolved non-system integration: first enforce `allowedIntegrations` (`not_allowed`), then scope-aware health (`needs_connect` / `needs_reauth`), then the existing schema parse, policy resolution, staging, and execute path. Gated results must use the same actionable envelope shape as existing tool failures: `{ status, message, integration?, candidates? }`, so both chat and workflow bosses can relay useful text.

6. **No v1 auto-activate path.** Because usable connected ∩ allowed integrations are declared from run start, there is no inactive-but-executable happy path to recover. This avoids adding `activate` metadata to `DispatchResult`, avoids transcript/staging disagreement between bare and resolved names, and avoids classifying recovered calls as failures.

7. **`system.load_integration` becomes compatibility/deferred surface.** It may remain registered for old prompts and future lazy mode, but v1 should not depend on it for normal tool visibility. If it is kept, it must call the same `integrationHealth` helper and return structured `needs_connect` / `needs_reauth` failures instead of `{ ok: true }` on a connected-but-wrong-scope Google credential.

8. **User action policy remains orthogonal.** Auto-declared write tools still flow through `resolvePolicyMode` and staging. Eager declaration is not eager execution; `autonomy | gated` remains the write safety layer.

**Dispatch floor (pseudocode).**

```
resolution = resolveToolName(args.toolName, { allowedIntegrations })
if resolution.kind == 'unknown':
  return { kind: 'unknown_tool', result: { status: 'unknown_tool', message: ... } }
if resolution.kind == 'ambiguous':
  return { kind: 'ambiguous_tool', result: { status: 'ambiguous_tool', message: ..., candidates } }

name = resolution.toolName
intg = integrationFromToolName(name)
if intg != 'system':
  if allowed.length && !allowed.includes(intg):
    return { kind: 'not_allowed', result: { status: 'not_allowed', message: ... } }
  health = integrationHealth(userId, intg)
  if health.status != 'active':
    return { kind: health.status, result: { status: health.status, message: health.message } }

// existing getTool(name) / safeParse / policy / staging / execute path
```

**What this amends.**

- **ADR-0026 / ADR-0040 #4 & #6** — strict `@`-mention lazy loading is superseded for v1. Tool declaration is now deterministic from connected ∩ allowed credentials at run start, while prompts stop asking the model to infer load steps.
- **ADR-0043** — the "active exposure bounded by `allowed_integrations`" layer becomes dispatch-enforced rather than exposure-only.

**Alternatives.**

- (a) **Lazy catalog + two-step `load_integration` + dispatcher auto-activate.** Rejected for v1 after measuring the current surface: the schema cost is small, Gemini currently ignores explicit `cacheControl`, and the auto-activate path adds state/result/transcript complexity for little benefit. Keep it as the future relaxation if integration count or schema size grows.
- (b) **One-step universal `system.call_tool(name, input)` meta-tool.** Rejected. It removes normal JSON-schema tool declarations, making argument formation worse for complex tools.
- (c) **Cheap-classifier pre-seed.** Rejected as a primary trigger. A model call is not a deterministic loading boundary.
- (d) **Prompt-only plus `system.list_integrations`.** Rejected. It is the old probabilistic design with an extra discovery turn.

**Deferred.**

- **Lazy mode** once real schema volume justifies it. If revived, it must preserve the dispatch gate, scope-aware health helper, structured result envelopes, and resolved-name audit consistency described here.
- **Per-tool (L3) trust** (`IntegrationRule.toolOverrides`) — still orthogonal to loading.
- **Mid-run catalog freshness** — connecting or revoking an integration mid-conversation refreshes on the next run unless this proves painful.

**Open.**

- **Catalog description source** — hand-authored one-liners vs. reusing each tool group's existing description. Use short per-integration blurbs and skip empty-action stubs.
- **Ambiguity tie-breaks** — v1 can return `ambiguous_tool`; smarter tie-breaks can come later if ambiguous bares become common.
- **Audit artifact for blocked calls** — dispatch gates currently short-circuit before staging. Decide during implementation whether `not_allowed` / `needs_connect` / `needs_reauth` should create an audit row, or whether transcript tool results are enough.

**Amendment (2026-07-14) — exact run-local tool surfaces (#407).** The eager integration-level declaration above is superseded. Run state now stores exact canonical tool names in `activeTools`; the global registry means only that the server can run a tool. SDK declarations are built from `activeTools`, and the dispatcher enforces both `allowedIntegrations` and exact active membership before input validation, policy, staging, or execution. A registered, allowed inactive call records a distinct `inactive_tool` trace, activates only that exact schema, and returns structured guidance so the next model turn issues a fresh call; the schema-blind arguments are never validated or executed. A disallowed call returns `not_allowed` and cannot activate. Persisted runs carrying `activeIntegrations` are expanded to registered exact names at the state-schema boundary; registered pending calls are preserved for durable approval resume, and the next checkpoint writes only the new shape. All current `system.*` tools remain the transitional kernel; #411 adds exact search/load/preload and #412 shrinks that kernel and retires integration loading.

**Amendment (2026-07-15) — lazy system tools and retired integration loading (#412).** The transitional all-system kernel is replaced by an explicit kernel surface (`availability.surface: "kernel"`), initially `system.search_tools`, `system.load_tool`, and `system.current_time`. Every other `system.*` capability is a normal catalog entry: deterministic preload or exact search/load may add it to `activeTools`, and the dispatcher still enforces exact membership. `system.load_integration` is deleted from the contract, registry, prompts/recovery copy, run-state effects, and UI presentation; there is no compatibility action. Legacy `activeIntegrations` checkpoints still perform the already-approved one-time state-shape migration, but receive only the explicit system kernel plus registered tools from their persisted non-system slugs. Current time is an in-process typed tool returning ISO instant, local date/time/weekday, IANA timezone, and UTC offset—never a shell escape. Connected-service grounding remains compact catalog text; full schemas appear only for exact active tools.

**Follow-up (2026-07-15, PR #519) — the kernel includes the cheap, hot tools the prompt advertises by name.** The initial three-tool kernel was too small: the chat/boss system prompt _unconditionally names_ five other `system.*` tools as its primary ladder (`read_user_context` for people/relationships/preferences, `web_search` for live lookups, `read_chat_history` for in-thread evidence, and the `spawn_sub_agent` → `await_sub_agent` delegation pair). A tool named in the prompt but absent from the turn-1 surface pays twice on first use: (1) it has no intent-bearing `discovery` metadata, so `preloadToolCatalog` is structurally _ineligible_ to preload it (`preloadEligible = matchedAlias || (matchedEntity && matchedVerb)`) — it can only be reached via the `search_tools → load_tool` dance; and (2) `load_tool` mutates the `tools` array mid-run, busting the Anthropic prompt-cache prefix on the next turn. So the five cheap ladder tools are marked `surface: "kernel"` too, making the kernel **eight tools**. A prompt-derived test enforces that every named `system.*` tool is either kernel or on an explicit intentionally-lazy allowlist; this represents the actual cheap/hot judgment instead of claiming prompt names and kernel membership are equal sets (`current_time` is eager temporal grounding, while the large artifact mutation schemas stay lazy). Because `systemToolKernel()` returns kernel names unfiltered, the `activeTools → ToolSet` projection (`buildSdkToolSet`) filters by the caller-context predicates also used by `availableToolNames` — `availability.callers` and `requiresThread` — so `read_chat_history` (thread-only) and both boss-only delegation tools stay eager in chat yet invisible where they cannot run. Integration allowlists and credential health remain load-time gates and are not re-checked by this projection. The giants stay lazy: the artifact tools are ~600 tok each (`create_artifact` 599, `append_artifact_page` 580) vs. the cheap named tools; the chat kernel remains substantially smaller than the pre-#412 all-system surface. Live proof on the hottest query class ("what do you know about X?"): boss turns **4 → 2**, and the mid-run full cache MISS is eliminated (before: turn-3 `cachedIn=0 cacheWrite=5944`; after: turn-2 `cachedIn=6149` hit) — verified against `api_call_log` for `run_59kn3qmdioal` (before) vs. `run_zs81kb9rn7dp` (after). The chat-turn and brief workflows share one `buildSdkToolSet` and one `applyPromptToolPreload` (in `agent/tool-surface.ts`) so the SDK-tool projection and the first-turn preload policy/telemetry cannot drift between entry points.
