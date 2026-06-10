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

## Build order (impact + clean foundations)

Settled 2026-06-10. Rationale and the surface decision live in **ADR-0054**.

1. **MEET-002 (decided)** — meeting prep is one canonical persisted `meeting_prep` record; **manual in-chat command** is the only v1 trigger; scheduled email and in-app card are deferred *renderers* of the same record.
2. **SEARCH-001 (foundation, in progress)** — shared citation contract landed before MEET-001 so there's one provenance grammar, not three. Briefing now delegates to it.
3. **MEET-001** — the gatherer, emitting into the citation shape (calendar + Gmail first; degrades gracefully).
4. **TODO-001 + MEM-001** — inputs that plug into MEET-001's empty slots; fast-follows, not blockers.
5. **UI-001 → QA-001 → DEMO-001 → POLICY-001** — render, lock the spine, seed, then copy polish.

## Done

| ID | Category | State | Item | Notes |
|---|---|---:|---|---|
| DONE-001 | bug | done | Green tree gate | Conflict markers resolved; targeted marker search and `git status` are clean. |
| CAL-001 | enhancement | done | Real `calendar.list_events` execution | `packages/api/src/modules/tools/calendar.ts:172` picks an active cred, checks scope, returns sorted non-cancelled events with `timeMin/timeMax/maxResults`. |
| CAL-002 | enhancement | done | Normalized event read model | `CalendarContribution` (`contracts/briefing.ts`) + `calendarEventToContributionEvent` (`gather.ts`) + `MeetingResponseItem` (`use-meetings.ts`). |
| BRIEF-001 | enhancement | done | Calendar-anchored briefings | `gatherCalendarContribution` feeds morning + daily workflows; morning suppression keys off meeting count. |
| SEARCH-001 | enhancement | done | Shared citation contract | `packages/contracts/src/citation.ts` — gather-agnostic `CITATION_KINDS`, `[[kind:id]]` grammar, `resolveCitations`. Briefing delegates to it (one resolver); tests in `packages/api/test/contracts/citation.test.ts`. ADR-0054. **Note:** this was the *contract* slice; a queryable citation-rows table stays deferred. |

## Now

| ID | Category | State | Item | Why now |
|---|---|---:|---|---|
| MEET-001 | enhancement | ready-for-agent | Build meeting-prep gatherer | **Scoped 2026-06-10** — see [meeting-prep-v1.md](./meeting-prep-v1.md) + ADR-0054 amendment. gather→flash-compose; threads from `documents` (`email:<documentId>`); `meeting_prep` synced read-only; `system.prepare_meeting` (autonomy); all 5 slots read existing data. 6 phases. |

## Next

| ID | Category | State | Item | Why next |
|---|---|---:|---|---|
| MEET-002 | enhancement | decided | Meeting-prep delivery surface | **Resolved (ADR-0054):** one canonical persisted `meeting_prep` record; manual in-chat command is v1's only trigger; scheduled pre-meeting email and in-app card are deferred renderers of the same record. |
| MEM-001 | enhancement | ready-for-agent | Relationship facts from Gmail + Calendar | Extract collaborator/person facts from attendee lists, senders, recipients, and repeated threads; require review before durable memory. |
| TODO-001 | enhancement | ready-for-agent | Feed todos into meeting prep and briefings | Suggested/open todos should appear when they match attendees, thread ids, or same-day context. |

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

## Explicit cuts for June

- No new integrations.
- No generic workflow builder expansion beyond what the demo uses.
- No org-level enterprise controls beyond copy/placeholder framing.
- No broad people-search automation unless manually triggered and review-gated.
- No graph visualization unless the relationship data is already solid.
