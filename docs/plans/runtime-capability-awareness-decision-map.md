# Runtime capability awareness decision map

Working name: "sentient" / "self-aware" AI. Product name still open.

Goal: Alfred should answer questions about what it can do, what is connected, what is missing, and what the current surface/device can support without sounding helpless or overclaiming. It should do this at runtime from trusted capability facts and live user/session state, not from vague prompt memory.

Bootstrap findings from 2026-07-07:

- The existing shape is agentic, but not yet capability-aware as a product surface. Chat has a connected summary and tool registry, but no general "what can Alfred do right now?" oracle.
- Static product copy and executable tool truth can drift. Example: the web catalog advertises Slack/Linear as available and lists Calendar update/delete/check-availability, while `INTEGRATION_ACTIONS` has Slack/Linear/iMessage empty and Calendar only `list_events`/`create_event`.
- The integration detail page already reads server-owned tool tier counts from `/api/integrations/tool-tiers`, so there is precedent for moving executable capability truth out of browser copy.
- Current chat run state snapshots timezone and connected summary, but does not carry client route, viewport class, device kind, platform, selected UI object, or screenshot/context from the current surface.
- Runtime repo/code inspection should not be the default production answer path. It is too slow, not necessarily deployed with source, and can confuse implementation detail with product truth. Code-derived manifests and audits are safer as the normal source; a dev-only introspection tool can remain an investigation aid.
- ADR-0053 says integration loading should be deterministic and dispatch-enforced. ADR-0071/0072/0078 establish the local pattern: encode capability/limitation facts in typed code, expose honest user-facing surfaces, and verify drift with focused tests/evals.

## #1: What Should "Self-Aware" Mean In Alfred?

Blocked by: none
Type: Discuss

### Question

What is the product contract and tone for this capability, independent of implementation?

### Answer

Unresolved.

Recommended direction: call the underlying architecture "runtime capability awareness", not "sentience" in product copy. Alfred should sound competent by being specific:

- "I can do that now because Gmail and Calendar are connected."
- "I can draft it, but sending will need your confirmation."
- "Slack is listed in the catalog, but no Slack actions are wired yet."
- "On this phone view, the artifact panel opens full-screen; on laptop it sits beside chat."

Avoid both extremes: no omniscient claims, and no apologetic "I am just an AI" disclaimers. The answer style should be "capability, condition, next action".

## #2: What Is The Canonical Capability Data Model?

Blocked by: #1
Type: Research

### Question

What typed manifest should represent Alfred's capabilities, limitations, prerequisites, risk, UI availability, and user-facing copy?

### Answer

Unresolved.

Frontier to investigate:

- Whether the source of truth belongs in `@alfred/contracts`, `@alfred/api`, or a new server-owned capability module with a browser-safe projection.
- Whether a capability is provider-level (`gmail`), action-level (`gmail.search`), workflow-level (`meeting_prep`), surface-level (`artifact_fullscreen`), model-level (`deep supports bigger research`), or integration-object-level.
- Required fields: stable id, title, plain-English "can do", "cannot do yet", prerequisites, connected-state resolver, risk/write policy, supported surfaces, provider scopes, source links to owning code, and test/eval coverage.
- How to derive rather than duplicate existing truth from `INTEGRATION_ACTIONS`, tool registry descriptions, risk tiers, OAuth scope constants, workflow registry, and model capability maps.

## #3: How Do We Reconcile Integration Catalog Copy With Executable Tools?

Blocked by: #2
Type: Prototype

### Question

Can the integrations page and chat answers share one server-owned capability projection so catalog copy cannot overpromise?

### Answer

Unresolved.

Known mismatch to prove and fix:

- `apps/web/src/lib/integrations/integrations.ts` advertises richer hand-written capabilities.
- `packages/contracts/src/tools.ts` and `packages/api/src/modules/tools/registry.ts` define executable actions and risk tiers.
- `packages/api/src/modules/integrations/tool-tiers-routes.ts` already exposes a narrow server projection to the web.

Prototype target: replace or augment `provider.capabilities` with an API projection such as `/api/capabilities/integrations`, where each displayed capability is tagged `available`, `connected`, `needs_connect`, `needs_reauth`, `planned`, or `unsupported`.

## #4: What Runtime Client Context Should A Chat Turn Carry?

Blocked by: #1
Type: Prototype

### Question

What should the web client send with a user message so Alfred can answer surface-specific questions like "where is the integrations page?" or "can I do this on mobile?"

### Answer

Unresolved.

Candidate context envelope:

- `routeId` / pathname, route params, and selected entity ids.
- Viewport class, pointer type, platform family, browser support flags, and local timezone.
- Active panel state: chat rail open/closed, artifact panel mode, current integration detail provider, selected approval/todo/briefing.
- Optional user-granted screenshot or DOM-derived semantic snapshot for "what am I looking at?" questions.

Design constraint: do not stream raw screenshots or DOM by default. Start with structured, low-entropy state the app already knows. Add screenshot capture only behind explicit user action and privacy copy.

## #5: Should The Agent Have A Capability Oracle Tool?

Blocked by: #2, #4
Type: Discuss

### Question

Should Alfred answer capability questions from prompt-injected context, or should it call a runtime tool like `system.describe_capabilities`?

### Answer

Unresolved.

Recommended hypothesis: use both, with different payload sizes.

- Prompt preamble: short cached summary of currently connected and unavailable major surfaces.
- Tool: structured query for detailed questions, for example "can I add Slack?", "what integrations support write actions?", "why can't you update Calendar events?", or "what can I do from this screen?"

The tool should return user-facing facts plus machine-readable evidence, not raw implementation paths. It should never bypass dispatch policy; it describes capability, it does not grant capability.

## #6: Can Query-Time Code Inspection Be Safe And Useful?

Blocked by: #2, #5
Type: Research

### Question

When the user asks "can Alfred do X?", should the deployed assistant inspect the repo/code at runtime?

### Answer

Partially resolved: not as the primary production path.

Recommended posture:

- Production answers use code-derived manifests generated at build/test time and live DB/user state at run time.
- Dev mode may expose a privileged code-inspection capability for the owner to ask "what does this repo currently implement?", clearly labeled as dev/debug.
- Drift detection belongs in tests and audit scripts: compare manifest claims against registry/tool routes/UI copy, similar to the per-model capability audit pattern.

Open work: define the dev/prod boundary and whether the source tree is even present in the deployed Railway image.

## #7: How Should Alfred Reason About Current Device And Screens?

Blocked by: #4
Type: Prototype

### Question

Do we need mobile screenshots, responsive screenshots, or live device inspection for the first version?

### Answer

Unresolved.

Recommended sequence:

1. Add structured client context first: route, viewport class, platform, and active panel state.
2. Build surface capability facts: which features exist on desktop, mobile, narrow overlay, fullscreen, and disabled states.
3. Add screenshot-on-demand only for support/debug questions where structured context is insufficient.

This keeps routine chat cheap and private while still allowing precise help when the user is asking about the visible UI.

## #8: How Should Alfred Explain Limitations Without Sounding Incompetent?

Blocked by: #1, #2
Type: Discuss

### Question

What answer policy should transform capability facts into language?

### Answer

Unresolved.

Candidate policy:

- Lead with the nearest useful action.
- Name the missing prerequisite only after saying what is possible.
- Prefer "not wired yet" for product gaps and "needs reconnect" for account gaps.
- Include the unlock path when there is one.
- Do not expose tool names, schemas, stack names, or internal errors in normal user answers.

Example: "You can connect Gmail, Calendar, Drive, Docs, Sheets, Slides, GitHub, Notion, Railway, and Vercel today. Slack and Linear are visible in the catalog but do not have live actions yet, so Alfred cannot read or post there until those backends land."

## #9: What Evals And Drift Guards Make This Durable?

Blocked by: #2, #3, #5, #8
Type: Research

### Question

How do we prevent future copy, tool, model, scope, and UI drift from reintroducing false claims?

### Answer

Unresolved.

Candidate checks:

- Unit invariant: every executable tool has a capability manifest row and user-facing label.
- Catalog invariant: every integration capability chip maps to an available/planned/unsupported manifest fact.
- Scope invariant: provider connection state and OAuth scopes produce the same health verdict in chat, integration pages, and dispatch.
- Chat evals: ask about Slack, Linear, Calendar updates, mobile artifact viewing, missing scopes, and connected GitHub identity; assert Alfred answers honestly and does not invent actions.
- Visual/e2e: integration detail pages render planned vs available states clearly on mobile and desktop.

## #10: What Is The Implementation Slice After The Map Is Resolved?

Blocked by: #1, #2, #3, #4, #5, #8, #9
Type: Discuss

### Question

Once the design choices are resolved, what is the first shippable slice?

### Answer

Unresolved.

Likely first slice:

1. Capability manifest for integrations and tools.
2. Server API projection for integration capabilities.
3. Integration page uses that projection instead of static chips for executable/planned state.
4. Chat gets `system.describe_capabilities` plus a compact preamble summary.
5. Add drift tests and two or three chat evals around known mismatches.

Defer screenshots, repo introspection, and broader workflow/model capability explanations until the manifest and language policy are proven on integrations.
