# Deterministic connected tools (eager declaration + dispatch floor)

**Date:** 2026-06-07
**ADR:** [ADR-0053](../../decisions.md#adr-0053--deterministic-connected-tool-declaration--dispatch-enforced-gates-supersedes-the-prompt-only-load-instruction-of-adr-00260040)
**Trigger:** Chat `454bad3d`. A clean GitHub turn was followed by a calendar follow-up that emitted bare `list_events` -> `undeclaredToolMessage` ("Tool 'list_events' is not declared") -> the boss gave up and asked the user to load Calendar.

---

## TL;DR

The bug has two separable parts:

1. **Visibility/loading:** v1 should not make the model infer load steps. Declare full schemas for connected ∩ allowed integrations at run start. The current real surface is small: Gmail, Calendar, Drive, Docs, Sheets, Slides, GitHub. Slack/Linear/iMessage have no actions yet.
2. **Security boundary:** `dispatchToolCall` must hard-enforce `allowedIntegrations` + scope-aware connection health before executing any non-system registered tool. This closes the ADR-0043 exposure-only hole even if a model emits a qualified tool directly.

Lazy catalog + two-step `load_integration` + auto-activation is deferred until schema volume proves it is worth the complexity.

---

## Key files

| Concern | File |
|---|---|
| Tool name types, action lists | `packages/contracts/src/tools.ts` |
| Registry (`getTool`, `listToolsForIntegration`) | `packages/api/src/modules/tools/registry.ts` |
| `system.load_integration` execute | `packages/api/src/modules/tools/system.ts` |
| Dispatcher (`dispatchToolCall`, `undeclaredToolMessage`, name resolution) | `packages/api/src/modules/dispatch/index.ts` |
| Boss preamble, `resolveSdkTools`, workflow run seed | `packages/api/src/modules/agent/workflows/user-authored-brief.ts` |
| Chat preamble, current `[]` seed | `packages/api/src/modules/agent/workflows/chat-turn.ts` |
| `integrationCredentials.status` | `packages/db/src/schema/integrations.ts` |
| Google scope mapping | `packages/integrations/src/google/oauth.ts` |
| Existing Google scope filters | `packages/api/src/modules/me/routes.ts` |

---

## Phase 1 - Scope-aware integration health

Add one source of truth for "can this user use this integration slug right now?"

- New helper, e.g. `integrationHealth(userId, slug): { status: 'active' | 'needs_connect' | 'needs_reauth'; message?: string }`.
- Treat non-`active` credential status as unusable.
- Make Google fan-out slug-aware:
  - `gmail` requires Gmail scopes.
  - `calendar` requires Calendar scopes.
  - `drive`, `docs`, `sheets`, `slides` require their service scopes.
  - A Calendar-only Google credential must not make Sheets/Slides/Drive active.
- Multiple Google rows reduce by:
  - any active row with required slug scopes -> `active`;
  - otherwise a relevant but unhealthy or insufficient row -> `needs_reauth`;
  - otherwise -> `needs_connect`.
- Skip empty-action stubs (`slack`, `linear`, `imessage`) in connected summaries and eager declaration.
- Keep this helper importable from `dispatch/`, `tools/system.ts`, and the run-seeding/catalog builder without cycles.

Tests:

- Calendar-only Google credential -> `calendar` active, `sheets` not active.
- Non-active Google credential with relevant scopes -> `needs_reauth`.
- No credential -> `needs_connect`.
- GitHub active credential -> `github` active.

## Phase 2 - Eager connected tool declaration

Replace strict `@`-mention seeding as the v1 declaration boundary.

- At run creation, compute `declaredIntegrations = connectedHealthySlugs ∩ allowedIntegrations`, where empty `allowedIntegrations` means all connected healthy loadable slugs.
- Seed `agent_runs.state.activeIntegrations` with that full set for:
  - user-authored workflows;
  - chat runs;
  - sub-agents, scoped to their `allowedIntegrations`.
- Leave `@`-mentions as prompt/intent hints only; they no longer decide whether a connected allowed tool schema is visible.
- Keep `resolveSdkTools` unchanged if possible: it already declares tools for `activeIntegrations`.

Tests:

- Workflow allowed `[gmail]` with Gmail+Calendar connected declares only Gmail tools.
- Empty allowlist with Gmail+GitHub connected declares both.
- Empty-action integrations are not declared.

## Phase 3 - Connected summary in the preamble

Keep a short, frozen grounding summary even though schemas are eager.

- Build at run start from connected ∩ allowed slugs.
- Format one line per non-empty integration: `slug — action, action — short description`.
- Include health markers for unusable-but-known credentials (`needs reauth`) if showing them helps the boss explain reconnects.
- Snapshot into run state, e.g. `state.connectedSummary`.
- Render via `system` resolver by concatenating the frozen string with `BOSS_SYSTEM_PROMPT`, `CHAT_SYSTEM_PROMPT`, or `SUB_AGENT_SYSTEM_PROMPT`.
- Do not do live DB/health reads in the resolver. The resolver must be pure over state.
- Remove prompt lines that tell the model to infer needed integrations and call `system.load_integration` just to proceed.

Tests:

- Two consecutive turns for the same run produce byte-identical system text when state is unchanged.
- The summary respects `allowedIntegrations` and does not leak disallowed slugs.

## Phase 4 - Dispatch floor

`packages/api/src/modules/dispatch/index.ts`

Insert name resolution and gating before the existing `isToolName`/`getTool` path.

1. **Resolve names.**
   - Qualified names pass through if valid.
   - Bare action names resolve to a qualified `ToolName` only when unique.
   - Ambiguous names such as `batch_update` return `ambiguous_tool` with candidates.
   - Unknown names keep existing `unknown_tool` behavior.
2. **Gate non-system tools.**
   - `not_allowed` if outside non-empty `allowedIntegrations`.
   - `needs_connect` / `needs_reauth` from `integrationHealth`.
3. **Return actionable envelopes.**
   - New results must include `{ status, message, ... }`, not only `{ kind }`.
   - Add explicit handling in both workflow `dispatchResultToToolOutput` functions. Prefer `assertNever` over chat's current broad default.
4. **Do not auto-activate in v1.**
   - Eager declaration means there is no inactive-but-usable path to recover.
   - Avoid adding `activate` metadata or mutating state from dispatch results.

Tests:

- Qualified disallowed tool returns `not_allowed` and does not execute.
- Qualified unavailable tool returns `needs_connect` / `needs_reauth` and does not execute.
- Bare `list_events` resolves to `calendar.list_events`.
- Bare `batch_update` returns `ambiguous_tool`.
- Gated write tool still stages when policy says `gated`; eager declaration does not bypass approval.

## Phase 5 - `system.load_integration` compatibility

`system.load_integration` can stay registered for old prompts and future lazy mode, but normal v1 visibility should not depend on it.

- Validate with the same `integrationHealth` helper.
- Return structured `needs_connect` / `needs_reauth` failures for unusable credentials.
- On success, no-op if the integration is already in `activeIntegrations`.

Tests:

- `load_integration('sheets')` with Calendar-only Google credential returns `needs_connect` or `needs_reauth`, not `ok: true`.
- Successful load remains idempotent.

---

## Testing

- **Regression:** two-turn chat: GitHub PR count, then "list my events tomorrow morning" must answer with Calendar tools visible from the start of the second run/turn path, with no "not declared" and no "would you like me to load..." message.
- **Security:** workflow scoped `allowed=[gmail]` cannot execute `calendar.create_event` even if the model emits the qualified name.
- **Scope:** Calendar-only Google credential does not advertise or execute Sheets.
- **Approvals:** eager-declared write tools still stage under `gated` policy.
- **System stability:** connected summary snapshot is byte-identical across turns unless run state changes intentionally.

## Risks / open

- **Blocked-call audit:** dispatch gates short-circuit before staging today. Decide whether `not_allowed` / `needs_connect` / `needs_reauth` need action-staging audit rows or transcript tool results are enough.
- **Catalog freshness:** mid-run connection changes refresh on the next run unless this becomes painful.
- **Lazy mode:** defer until real schema volume justifies it. If revived, keep the dispatch gate and scope-aware health helper unchanged.
- **Typeahead:** unrelated UI nit from the review; current custom select has listbox + arrow/Home/End but not type-to-jump.
