# June demo triage backlog

Goal: make Alfred demo-ready by June 30, 2026 without adding more integrations. The demo spine is
Google-backed: Calendar + Gmail + memory + todos + briefings + approval-gated actions.

This uses a lightweight issue-triage state machine, adapted from AI Hero's `/triage` framing:
each item has exactly one category and one state. There is no Jira/GitHub dependency; this file is
the backlog.

## Labels

Categories:

- `bug` — something already intended is broken.
- `enhancement` — new capability, polish, or product hardening.

States:

- `needs-triage` — useful, but needs a product/technical decision before implementation.
- `needs-info` — blocked on missing external/user information.
- `ready-for-agent` — scoped enough for an agent to implement.
- `ready-for-human` — requires manual console/account/product judgment.
- `wontfix` — explicitly out of scope.

## Done

| ID | Category | State | Item | Notes |
|---|---|---:|---|---|
| DONE-001 | bug | done | Green tree gate | Conflict markers resolved; targeted marker search and `git status` are clean. |

## Now

| ID | Category | State | Item | Why now |
|---|---|---:|---|---|
| CAL-001 | enhancement | ready-for-agent | Wire real `calendar.list_events` tool execution | Calendar is already implemented in `@alfred/integrations`; tool execution still needs to stop being a pending stub. This unlocks chat, rail, meeting prep, and briefing quality. |
| CAL-002 | enhancement | ready-for-agent | Normalize Calendar event read model | Meeting prep and briefings need one compact event shape: title, time, attendees, location/link, description snippet, credential/source ids. |
| MEET-001 | enhancement | ready-for-agent | Build meeting-prep gatherer | Highest demo value: upcoming event -> attendees -> recent Gmail threads -> memory facts -> open todos -> cited prep packet. |
| BRIEF-001 | enhancement | ready-for-agent | Make briefings Calendar-anchored | Morning/evening briefings should treat Calendar as the day spine and email/todos as context around it. |
| GROUND-001 | bug | ready-for-agent | Run grounding: inject date + connected summary into boss/chat prompt | Demo-killer fix. The boss today knows neither today's date (`how many meetings in October` → "which year?") nor which integrations it's connected to. Date fix is built but stranded on `fix/briefing-too-long` (`c3ba3433`); the ADR-0053 connected summary was specced but never built. |
| GROUND-002 | bug | ready-for-agent | Wire `system.read_user_context` as a boss/chat tool | The whole memory substrate exists but the boss can't read it — the tool is specced (ADR-0042) and the function exists (`readTriageUserContext`) but was never registered. First slice of the Track 2 read surface. |
| GROUND-003 | bug | ready-for-agent | Tool-selection recovery: enumerate real actions in `unknown_tool` | When the boss invents `github.list_pull_requests`, the dispatch floor returns only "is not declared" — no list of real actions. Cheapest lever against tool invention. |

## Next

| ID | Category | State | Item | Why next |
|---|---|---:|---|---|
| MEET-002 | enhancement | needs-triage | Decide meeting-prep delivery surface | Choose first surface: in-chat manual command, scheduled email 20 min before, in-app card, or all with one canonical persisted record. Recommendation: manual chat first, then scheduled email. |
| MEM-001 | enhancement | ready-for-agent | Relationship facts from Gmail + Calendar | Extract collaborator/person facts from attendee lists, senders, recipients, and repeated threads; require review before durable memory. |
| SEARCH-001 | enhancement | ready-for-agent | Evidence layer for cited outputs | Shared citation rows for Gmail message, Calendar event, memory fact, todo, and briefing source panel. This is narrower than full search and directly supports demo trust. |
| TODO-001 | enhancement | ready-for-agent | Feed todos into meeting prep and briefings | Suggested/open todos should appear when they match attendees, thread ids, or same-day context. |
| MEM-002 | enhancement | needs-triage | Long-term memory foundation (Track 2 epic) | The assistant's persistent memory beyond the demo. **Storage substrate is frozen/adopted as-is** (`user_facts` w/ confidence·status·source·valid_until·supersedes, `entities`+`entity_relations`, `memory_chunks` pgvector, `style_profiles`, `rejected_inferences`) — not redesigned. Four design problems under active grill (see below). Detailed design lands in `docs/plans/long-term-memory-v1.md`. ADR-0050 D1/D2/D3 are the parked seeds. |

## Later This Month

| ID | Category | State | Item | Why later |
|---|---|---:|---|---|
| DEMO-001 | enhancement | ready-for-human | Create seeded demo account/script | Needs human taste: realistic fake calendar, emails, people, and a 5-minute narrative. Should happen after core behavior is real. |
| QA-001 | bug | ready-for-agent | End-to-end smoke suite for demo spine | One command should verify onboarding-complete user, Google credential present, Calendar list works, meeting prep composes, briefing dry-run composes. |
| UI-001 | enhancement | ready-for-agent | Polish meeting-prep and briefing citation UI | Use the Dimension reference only as interaction grammar: compact source rows, collapsible supporting evidence, clear provenance. |
| POLICY-001 | enhancement | needs-triage | Permission cockpit copy pass | Existing action policy is strong; decide how much permission explanation appears in onboarding, settings, and approval cards without overwhelming the demo. |

## Agent-ready briefs

### CAL-001 — Wire real `calendar.list_events`

Files to start:

- `packages/api/src/modules/tools/calendar.ts`
- `packages/integrations/src/google/calendar.ts`
- `packages/integrations/src/google/scopes.ts`
- `packages/integrations/src/google/oauth.ts`

Acceptance:

- `calendar.list_events` picks an active Google credential for the user.
- It checks the Calendar feature scope before calling Google.
- It returns non-cancelled events sorted by start time.
- It supports optional `timeMin`, `timeMax`, `maxResults`.
- Missing scope returns the existing missing-scope path, not a generic failure.
- Typecheck and focused tests pass.

Notes:

- Do not add a new Google provider/client dependency.
- Keep `calendar.create_event` gated and secondary; list/read is the demo unlock.

### CAL-002 — Normalize Calendar event read model

Files to start:

- `packages/contracts/src/briefing.ts`
- `packages/api/src/modules/briefing/gather.ts`
- `apps/web/src/hooks/use-meetings.ts`
- `apps/web/src/routes/-preview-chat/meetings-feed.tsx`

Acceptance:

- One internal event shape supports briefings, chat rail, and meeting prep.
- Attendees include email and display name when available.
- Timed and all-day events both render cleanly.
- Empty/no-calendar states remain explicit.

### MEET-001 — Build meeting-prep gatherer

Suggested module:

- `packages/api/src/modules/meeting-prep/`

Inputs:

- `userId`
- `calendarEventId` or `{ timeMin, timeMax, attendeeHint? }`

Gather:

- Calendar event details.
- Attendee entities and known aliases.
- Recent Gmail threads involving attendees.
- Confirmed memory facts and relationship facts.
- Open/suggested todos whose sources overlap attendees, Gmail threads, or the event.

Acceptance:

- Returns a structured prep packet with citations, not just prose.
- Handles missing Gmail/memory/todos by degrading gracefully.
- Has deterministic unit tests around attendee matching and source selection.

### BRIEF-001 — Calendar-anchored briefings

Files to start:

- `packages/api/src/modules/briefing/gather.ts`
- `packages/api/src/modules/briefing/compose.ts`
- `apps/server/src/builtins/workflows/morning-briefing.ts`
- `apps/server/src/builtins/workflows/daily-briefing.ts`

Acceptance:

- Morning briefing prioritizes today's/tomorrow's meetings and live loops connected to them.
- Evening briefing includes closed/open loops and tomorrow prep.
- Missing Calendar scope surfaces as "could not verify calendar", not silent omission.
- Source panels include Calendar events and Gmail threads used in the prose.

### GROUND-001 — Run grounding (date + connected summary)

Files to start:

- `packages/api/src/modules/agent/grounding.ts` + `user-timezone.ts` (recover from `fix/briefing-too-long` `c3ba3433`, don't rewrite)
- `packages/api/src/modules/agent/workflows/chat-turn.ts` + `user-authored-brief.ts` (system-prompt assembly)
- new connected-summary builder (ADR-0053: `slug — actions — short desc`, `(needs reauth)` markers)
- `packages/api/evals/date-grounding.eval.ts` (comes with the branch)

Acceptance:

- Today's date + IANA timezone injected into **both** boss and chat system prompts.
- Connected summary built from connected ∩ allowed integrations, **snapshotted into `agent_runs.state` at run start**, concatenated by the `AlfredAgent` system resolver — **no live DB/health reads mid-turn** (cache-stable per ADR-0053/0026).
- Grounding is one run-start snapshot, not recomputed per turn (stable cached prefix).
- `date-grounding` eval passes; add a connected-summary assertion.

Notes:

- This is the general **Run grounding** seam (Track 2 ambient facts plug in here later) populated with exactly two members today: date + connected summary.

### GROUND-002 — Wire `system.read_user_context`

Files to start:

- `packages/api/src/modules/triage/user-context.ts` (`readTriageUserContext` — promote to a shared reader)
- system tool registry + `SYSTEM_ACTIONS` in `@alfred/contracts`

Acceptance:

- `system.read_user_context` registered as an always-available system tool (autonomy, `no_risk`) for boss, chat, and sub-agents.
- Returns profile + `valid_until`-filtered confirmed facts + entities + preferences + recent memory, bounded.
- Boss/chat prompt instructs reaching for it when the user references people, relationships, or personal context.

Notes:

- Read-only; orthogonal to `user_action_policies`. Function already exists — this is wiring + prompt.
- **Sequencing reality:** near-no-op over today's empty prod tables (`entities` = 0) until capture (MEM-001 / MEM-002) lands.

### GROUND-003 — Tool-selection recovery envelope

Files to start:

- `packages/api/src/modules/dispatch/index.ts` (`undeclaredToolMessage`, `integrationActionSuggestion`)

Acceptance:

- An unknown action on an allowed + connected integration returns that integration's **real action list** ("github exposes: `search_pull_requests`…"), not just "is not declared."
- `integrationActionSuggestion` handles qualified names (today it bails on any `.`).
- Message is actionable: closest-match suggestion + the valid action set.

### MEM-002 — Long-term memory foundation (design LOCKED 2026-06-11)

Track 2 of the grounding/memory grill. **Design complete:** `ADR-0056` (governance) + `ADR-0057` (capture + significance + chat→memory). Storage substrate frozen/adopted as-is. Full phased plan + acceptance → **`docs/plans/long-term-memory-v1.md`** (P0–P6).

- **Governance:** autonomous-write + tiered-notify + always-reversible; confidence gates notification + review label, not the write; per-kind lifecycle; write-time-contradiction + user-feedback self-correction (decay → D2 post-demo); rejection `cause`; cheap-model rationale per write (→ SEARCH-001); corrections feed the eval lane, no auto-tuning.
- **Capture:** fully passive (integrations + significance-gated web-search enrichment) + proactive chat→memory; no onboarding interrogation. Builds `person_profiles`.
- **Significance score:** one shared primitive (frequency + recency + reciprocity + org-domain + relations); consumers = enrichment gate, todo D1, triage priority, meeting-prep.
- **Read surface:** three channels — Run grounding (ambient: date + connected summary + standing instructions), tool schemas, `read_user_context` (pull-on-demand).

**Demo slice** = P0–P4 (grounding unblock + read surface + significance + passive capture so `entities` ≠ 0). **Post-demo** = decay (D2), Loop-2 eval wiring, hybrid FTS+vector retrieval.

## Explicit cuts for June

- No new integrations.
- No generic workflow builder expansion beyond what the demo uses.
- No org-level enterprise controls beyond copy/placeholder framing.
- No broad people-search automation unless manually triggered and review-gated.
- No graph visualization unless the relationship data is already solid.
