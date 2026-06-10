# Meeting prep v1 (MEET-001) — implementation plan

Implements **[ADR-0054](../../decisions.md#adr-0054)** + its **2026-06-10 MEET-001 scoping
amendment** (meeting prep: one canonical persisted record, manual-chat-first, rendered through
the SEARCH-001 citation contract). Read ADR-0054 first — this plan is the build sequence, not the
rationale.

Cross-references: [`../../CONTEXT.md`](../../CONTEXT.md) (glossary: *Meeting prep packet*,
*`meeting_prep` record*, *`system.prepare_meeting`*, plus *Briefing*, *Gather source*, *Briefing
reference*, *User context*, *Todo `sources`*, *System-tool dispatch contract*),
[`../../decisions.md`](../../decisions.md) (ADRs 0041, 0049, 0050, 0053, 0054),
[`../reference/replicache.md`](../reference/replicache.md) (new-synced-entity recipe — Phase 4),
[`../reference/briefing.md`](../reference/briefing.md) (the gather→compose→store template MEET-001
mirrors).

> **Status.** Design grilled and locked 2026-06-10 (resolutions folded into the ADR-0054
> amendment). SEARCH-001 (the shared citation contract) shipped first: `packages/contracts/src/
> citation.ts` (`CITATION_KINDS`, `[[kind:id]]` grammar, `resolveCitations`); briefing already
> delegates to it. MEET-001 emits into that contract. CAL-001/CAL-002/BRIEF-001 are done, so
> `calendar.list_events`, the normalized event shape, and `documents` (gmail, `newer_than:30d`) are
> all live inputs. Ready to build.

## The shape, end to end

```
user: "prep my 2pm with Sarah"
  boss → calendar.list_events  (resolve the event id)
  boss → system.prepare_meeting({ calendarEventId })   [autonomy, never gated]
           gather()   [deterministic, no LLM]
             event     ← listEvents(eventId)              cite meeting:<credId:eventId>
             attendees ← parse event.attendees
             threads   ← documents WHERE gmail ∧ attendee∈from/to/cc   cite email:<documentId>
             facts     ← entities (alias match) + user_facts/relations  cite memory:<entityId|factId>
             todos     ← todos WHERE sources overlap attendee/thread     cite todo:<todoId>
           compose()  [flash-tier cheap LLM]  → summary prose w/ [[kind:id]]
           store      → upsert meeting_prep (user_id, calendar_event_id); status machine
           return     → { meetingPrepId, summaryMarkdown (chat-ready cite-links), packet }
  boss relays summaryMarkdown in chat
  (later) /meetings/$eventId card renders the synced row via EntityChip resolver  ← UI-001
```

One canonical `[[kind:id]]` form on the record; per-surface renderers (chat = `[label](url
"cite")` via `resolveCitations`; card = `EntityChip`, reused from briefing).

## Phase 1 — Contracts + schema (foundation)

- **`packages/contracts/src/meeting-prep.ts`** (new). Zero Node deps (web-boundary safe, like
  `briefing.ts`). Define:
  - `MeetingPrepPacket` + zod: `{ event, attendees: AttendeePrep[], threads: ThreadRef[], facts:
    FactRef[], todos: TodoRef[] }`. Each `*Ref` carries a `Citation` (from `citation.ts`) + the
    display fields its renderer needs (label, snippet, href, `threadId` on `ThreadRef` for dedup).
  - `MeetingPrepSummary`: `{ markdown: string /* canonical [[kind:id]] */ , citations: Citation[] }`.
  - `MeetingPrepStatus = pending|gathering|composing|composed|failed` enum + schema.
  - `prepareMeetingInput` zod: `{ calendarEventId: string }` (mirrors the other tool input
    schemas in this package; consumed by `tools/system.ts`).
  - Re-export the entity map the surfaces resolve against (a `ReadonlyMap<Citation, …>` builder,
    paralleling `listBriefingReferenceOptions`).
  - Add `prepareMeetingInput` to the `system` action list so `ToolName` includes
    `system.prepare_meeting` (`packages/contracts/src/tools.ts` `SYSTEM_ACTIONS`).
  - Add `'meeting_prep'` to the `CallRole` union (`packages/ai/src/metering/types.ts`).
- **`packages/db/src/schema/meeting-prep.ts`** (new). `meeting_prep` table, `createId('mtg')`,
  `lifecycle_dates`, `userId` FK→user `onDelete:'cascade'` (single-user FK cascade rule), columns
  per the glossary entry: `calendarEventId text`, `status`, `gather jsonb .$type<MeetingPrepPacket>()`,
  `summary jsonb .$type<MeetingPrepSummary>()`, `model text`, `agentRunId text`, `rowVersion integer`.
  `uniqueIndex(userId, calendarEventId)`. Export from `packages/db/src/schemas.ts`.
- **Migration**: `db:generate` → `db:migrate` (never `db:push`).

**Acceptance:** `pnpm check-types` green on a fresh tree; contract + schema agree by construction.

## Phase 2 — The gatherer (deterministic, no LLM)

New module `packages/api/src/modules/meeting-prep/`, mirroring `briefing/`.

- **`gather.ts`** — `gatherMeetingPrep({ userId, calendarEventId }): Promise<MeetingPrepPacket>`.
  - **Event**: split `calendarEventId` on first `:` → `{ credentialId, eventId }`; fetch via
    `getFreshAccessToken` + `listEvents`-style single read (reuse the CAL-001 path in
    `tools/calendar.ts` / `integrations/google/calendar.ts`). Cite `meeting:<calendarEventId>`.
  - **Attendees**: parse `event.attendees` (`"Name <email>"` → lowercased email + displayName);
    drop the user's own account email(s) and resource/room attendees (no email); cap ~8 (organizer
    + `accepted` first). Helper `parseAttendees()` — pure, unit-tested.
  - **Threads**: per attendee, query `documents` WHERE `source='gmail'` AND email ∈
    `metadata->>'from'|'to'|'cc'` (ILIKE), `ORDER BY authored_at DESC`, dedupe to one entry per
    `sourceThreadId`, top ~5. Map to `ThreadRef` (cite `email:<documentId>`, carry `threadId`,
    `metadata.snippet`, `url`).
  - **Facts**: per attendee, `findEntity` by alias containment (the `isKnownContact` pattern) →
    `getRelatedEntities` + confirmed `user_facts`. New small helper **`read.ts:
    relationsForEntity(userId, entityId)`** over `entities`/`entity_relations`/`user_facts`
    (`status='confirmed'`). Cite `memory:<entityId>` / `memory:<factId>`.
  - **Todos**: `todos` WHERE `status ∈ {open, suggested}`, filtered (app-side or jsonb-containment)
    to those whose `sources` include a `(gmail, thread, <gatheredThreadId>)` ref or reference an
    attendee. Cite `todo:<todoId>`.
  - Every slot degrades to `[]` independently (missing scope / no creds / no data ⇒ empty, never
    throws). Calendar read failure on the event itself ⇒ the one hard error (no event = no prep).

**Acceptance:** deterministic unit tests for `parseAttendees` (name/email parsing, self + room
drop, cap), thread dedupe-by-threadId, and source-overlap todo matching. No LLM in this file.

## Phase 3 — Compose (flash-tier)

- **`compose.ts`** — `composeMeetingPrep({ packet }): Promise<MeetingPrepSummary>`. One
  `meteredGenerateText`/`meteredGenerateObject` call on the **flash cheap model**, `attribution.role
  = 'meeting_prep'`. Prompt: summarize the packet into a tight prep paragraph, emitting `[[kind:id]]`
  tokens for every referenced item (reuse the briefing composer's reference instructions). Output
  validated; `citations` derived via `referencesFromSections`-style scan (or `resolveCitations`
  against the packet entity map → `resolved`). Degrades to a deterministic one-line fallback when the
  model call fails (record `composeFallback`).

**Acceptance:** given a fixture packet, compose returns markdown whose `[[kind:id]]` tokens all
resolve against the packet's entity map (no dangling citations).

## Phase 4 — Store + Replicache sync

- **`store.ts`** — mirror `briefing/store.ts`: `beginMeetingPrep` (idempotent upsert on
  `(userId, calendarEventId)` with regenerate-on-existing, since prep is regenerable not
  once-per-day), `markGathering/Composing/Composed/Failed`, `rowVersion` bump + `updatedAt` on every
  update. `rowToMeetingPrep` projector.
- **Replicache** (follow `docs/reference/replicache.md` recipe): fetcher enriching the synced row,
  `IDB_KEY.MEETING_PREP({ id })`, pull-window policy, `@alfred/sync` read schema. **No client
  mutators** (read-only, exactly like `briefings`). Add the entity to the pull set.

**Acceptance:** a composed row appears in the client IDB after sync; clearing client IDB + re-pull
reproduces it (the restart pull-loop gotcha from the briefing work applies — clear browser IDB to
test the newly-synced entity live).

## Phase 5 — Tool + chat render

- **`tools/system.ts`** — add a `liveTool({ integration: 'system', action: 'prepare_meeting',
  riskTier: 'no_risk', inputSchema: prepareMeetingInput, … })`. `execute(input, ctx)` →
  `gatherMeetingPrep` → `composeMeetingPrep` → `store` (passing `ctx.userId`, `ctx.runId` as
  `agentRunId`) → return `{ meetingPrepId, summaryMarkdown, packet }`. `summaryMarkdown` resolves the
  canonical `[[kind:id]]` tokens to the chat `[label](url "cite")` grammar via `resolveCitations` +
  the packet entity map (one render path; the boss relays it). System namespace → autonomy override
  (CONTEXT.md *System-tool dispatch contract*) → never gated.
- **Tool copy**: register the label in `TOOL_LABELS` (contracts) so chat rows show "Preparing
  meeting prep…".

**Acceptance:** in a chat run, `system.prepare_meeting` returns inline (no HIL park) and the relayed
summary renders cite-pills via the existing `citation-link.tsx`.

## Phase 6 — Smoke + tests

- **`apps/server/src/scripts/smoke-meeting-prep.ts`** — pick the user's next event via
  `calendar.list_events`, run gather→compose→store, assert a `composed` row with a non-empty packet
  and fully-resolving citations. (Bundle as a tsdown entry to run on prod via `railway ssh`, per the
  triage-backfill precedent.)
- Wire into QA-001's demo-spine command later.

## Explicit cuts for v1 (deferred, per ADR-0054 amendment)

- Scheduled pre-meeting **email** renderer.
- In-app meeting **card UI** (UI-001) — only the synced data layer lands here.
- **Live-search** thread fallback for >30d coverage.
- **MEM-001** (extract *new* relationship facts) and **TODO-001** (briefing-side todo feed) —
  MEET-001 only *reads* existing facts/todos.
- Queryable citation-rows table.
