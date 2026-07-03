# Meeting prep v1 (MEET-001) — implementation plan

Implements **[ADR-0054](../../decisions.md#adr-0054)** (meeting prep: persisted
per-occurrence packet + calendar-watch trigger), the **meeting-prep gatherer** from
[`june-demo-triage.md`](./june-demo-triage.md) (MEET-001), expanded during the 2026-06-10/11
grilling to fold in the proactive calendar-watch trigger. Read ADR-0054 first for the
rationale; this file is the build sequence.

Cross-references: [`../../CONTEXT.md`](../../CONTEXT.md) (glossary: *Meeting prep packet*,
and the new terms this plan lands — *`meeting_preps`*, *`system.prepare_meeting`*, *Prep
reference*, *Calendar watch*, *Prep horizon*, *Gated recompute*),
[`../../decisions.md`](../../decisions.md) (ADRs 0024 change-notifications, 0041 briefing
cross-source compose, 0047 `emitEvent` event-trigger dispatch, 0049 reference resolver in
contracts, 0050 todos, 0053 dispatch-enforced gates), the briefing pipeline it mirrors
(`packages/api/src/modules/briefing/{gather,compose,store,read,references}.ts`), and the
Gmail-watch precedent it mirrors (`packages/integrations/src/google/watch.ts`).

> **Status.** Design grilled and locked 2026-06-10/11; **ADR-0054 written** after the
> earlier "ADR-0054" memory was confirmed to be only a prior grilling conclusion, not a
> committed decision. No code yet: there is no `meeting_preps` table, no
> `system.prepare_meeting` tool, no calendar event source, and no calendar watch
> (`watch.ts` is Gmail-only). Ready to build.
> The substrate it builds on is real and shipped: `calendar.list_events`
> (`executeListEvents`), `compactEvent`, the briefing gather/compose/store/sync pipeline,
> the `documents` corpus (`source='gmail'`, `metadata.{from,to,cc}`, `sourceThreadId`),
> the memory tables (`entities`/`entity_relations`/`user_facts`/`memory_chunks`), `todos`
> (`sources: TodoSource[]`), and the `emitEvent` bus.

**Build rule.** Phases are ordered. Do not start the calendar-watch work until the
manual/chat path can create a synced `ready` prep row; that keeps the hard-to-debug
webhook path out of the first correctness loop.

---

## 1. Why (one paragraph)

Meeting prep is the highest-value demo surface: an upcoming event → who's coming → the
recent threads with them → what Alfred knows about them → the open todos that touch the
meeting → a short cited note, ready *before* you walk in. It exercises every part of the
spine at once (Calendar + Gmail corpus + memory + todos + citations) and is the clearest
proof that Alfred is a unified work hub, not a single-channel tool. v1 ships the **packet**
(gather → compose → persist → sync) plus the **proactive trigger** (a calendar push channel
that preps qualifying meetings as they enter a 48h horizon). The **delivery surface** (a
pre-meeting email, web augmentation at send) is deliberately MEET-002.

## 2. The spine

```
TRIGGERS (all converge on one tool)
  • system.prepare_meeting tool      boss calls it on "prep me for my 1:1 with Sakshi"
  • calendar push (events.watch)     change-driven; near-term events only
  • horizon sweep (~20m cron)        events crossing into [now, now+48h] w/o fresh prep
        ↓  emitEvent({ kind: 'calendar.event_scheduled', eventKey })  (ADR-0047)
        ↓
prepareMeeting(userId, eventKey | { timeMin, timeMax, attendeeHint? })
        ↓
[recompute gate]                     deterministic, no LLM:
                                       • no row yet                  → full gather+compose
                                       • material change (attendees/ → full gather+compose
                                         agenda/location/attachments)
                                       • time-only shift             → update event_start, SKIP
                                       • unchanged + fresh           → no-op
        ↓
gather (deterministic core + 1 vector recall)
   • event details         calendar.list_events read model (live)
   • attendees             email + display name, response status
   • email threads         scan documents(source='gmail') ∩ attendee emails,
                             group by source_thread_id, cite email:<documentId>
   • memory facts          entities ∩ attendee email → entity_relations + user_facts
                             + memory_chunks vector recall (enrichment, bounded)
   • todos                 todos.sources ∩ {thread ids, attendee emails}
        ↓
compose (boss-tier, meteredGenerateObject)
   short cited note with [[meeting:…]] / [[email:…]] / [[todo:…]] placeholders
        ↓
upsert meeting_preps (user_id, event_key)   status machine; gather jsonb (audit) + note
        ↓
Replicache sync (read-only)  →  in-app prep surface (UI is UI-001 / MEET-002 territory)
```

The cheap-vs-quality split is deliberate (grilling 2026-06-11): **minimize the *number* of
composes** (recompute gate + 48h horizon) and spend **boss-tier quality** on each one that
fires. "Minimise costs" was about frequency, not tier.

## 3. Data model

### 3a. `meeting_preps` (new — `packages/db/src/schema/meeting-preps.ts`)

Mirrors `briefings`: one status-machine row per calendar occurrence, `gather` jsonb for
audit/replay, composed `note`, `row_version` for Replicache.

```ts
meeting_preps
  id            text pk  createId("prep")
  user_id       text fk → user.id  ON DELETE CASCADE        // single-user FK cascade
  event_key     text     `${credentialId}:${googleEventId}` // singleEvents=true → per-occurrence
  status        text     'pending'|'gathering'|'composing'|'ready'|'failed'|'cancelled'
  event_start   timestamptz                                  // horizon gate + ordering + prune
  event_title   text                                         // denormalized for list views
  material_hash text                                         // sha256 of attendees+agenda+location+attachments
  gather        jsonb                                        // MeetingPrepGather (audit/replay)
  note          jsonb                                        // composed, cited (MeetingPrepNote)
  model         text                                         // model id that composed
  computed_at   timestamptz                                  // freshness watermark
  row_version   integer  default 0
  ...lifecycle_dates
  UNIQUE(user_id, event_key)
  index (user_id, event_start)                               // sweep + prune + sync window
```

- **Upsert, recompute-in-place** (locked): re-running `prepareMeeting` for the same
  `event_key` overwrites `gather`/`note`, bumps `row_version`, updates `computed_at`. The
  prep always reflects latest event state. No version history (rejected: storage + "which
  is current" read concern, demo doesn't need drift).
- **`material_hash`** is the recompute-gate discriminator: time-only shift leaves it
  unchanged → cheap path (update `event_start` only). Attendee/agenda/location/attachment
  change flips it → full recompute.
- **Prune from sync** after `event_start + window` (mirror briefings' 30-day pull window;
  past preps fall out of the Replicache pull).
- **Cancelled is terminal, not failed.** Calendar deltas can report a deleted/cancelled
  occurrence after a prep exists. Mark the row `cancelled`, bump `row_version`, and exclude
  it from the active prep pull; keep the row as audit rather than hard-deleting it.

### 3b. Calendar watch cursor (`integration_credentials.metadata.calendarWatch`)

No new table — mirror Gmail's `metadata.watch` (ADR rationale: at most one watch per
credential, state irrelevant outside the watch module).

```ts
metadata.calendarWatch = {
  channelId:   string,   // our uuid, maps push → credential
  resourceId:  string,   // Google's opaque resource id
  expiresAt:   string,   // ISO; renewal cron watches this
  syncToken:   string,   // incremental events.list cursor (NOT historyId — Calendar uses syncToken)
  calendarId:  'primary', // v1: primary calendar only
}
```

### 3c. No event mirror (locked)

Watch maintains the `syncToken` cursor only; push handler acts on the
`events.list(syncToken)` delta live, the sweep does a bounded live `events.list(now, now+48h)`,
and the prep gather reads the event live (snapshotting it into `meeting_preps.gather`).
Reuses the existing live-read path (consistent with how briefings read calendar today);
CAL-002's documents-backed mirror can land later without reworking this.

## 4. Contracts (`packages/contracts/src/meeting-prep.ts` — new)

Zero Node deps, mirrors `briefing.ts` so the table column `.$type<>()`s and the Replicache
read schema agree by construction.

- **`MeetingPrepGather`** — the structured gather: `{ event, attendees[], threads[], facts[], todos[] }`,
  each carrying the ids needed for citation/audit (`threads[].documentId`, `todos[].id`,
  `facts[].id`).
- **`MeetingPrepNote`** — composer structured output: `{ headline, sections: { label, body, why? }[], talkingPoints? }`,
  prose carrying `[[<kind>:<id>]]` placeholders.
- **`MEETING_PREP_REFERENCE_KINDS = ['meeting','email','todo'] as const`** + parallel
  resolver `resolveMeetingPrepReferences(prose, gather)`, `parseMeetingPrepReference`,
  `listMeetingPrepReferenceOptions` — mirrors the briefing resolver (relocated to contracts
  per ADR-0049), expanding against the *prep* gather. Briefing's enum/resolver stay
  untouched (locked: parallel, not extend, not generalize).
  - `meeting:<eventKey>` → static chip (no nav target v1)
  - `email:<documentId>` → Gmail thread url (clickable)
  - `todo:<todoId>`      → rail deep-link (navigable)
  - **memory facts are NOT a citation kind** — woven into prose; `gather.facts[].id`
    retained for audit and a future SEARCH-001 evidence layer.

## 5. Components & files

| Area | File | What |
|---|---|---|
| Schema | `packages/db/src/schema/meeting-preps.ts` (new), `packages/db/src/schemas.ts` | table export + migration; `db:generate` → `db:migrate` (never `db:push`) |
| Contracts | `packages/contracts/src/meeting-prep.ts` (new), `packages/contracts/src/index.ts` | gather/note zod schemas + types, reference enum + resolver |
| Tool contracts | `packages/contracts/src/tools.ts`, `packages/contracts/src/tool-schemas.ts`, `packages/contracts/src/tool-fields.ts` | add `system.prepare_meeting`, input schema, tool label/field metadata |
| Event contracts | `packages/contracts/src/event-triggers.ts` | add source `calendar` + type `event_scheduled`; `emitEvent` refuses unknown source/type pairs |
| Event dispatcher | `packages/api/src/modules/workflows/events.ts` | preserve bounded event payload in `createRun.input` / trigger payload so calendar workflows can read `eventKey` |
| Sync contracts | `packages/sync/src/keys.ts`, `packages/sync/src/schemas.ts` | `MEETING_PREP` IDB key + `SyncedMeetingPrep` read schema |
| Replicache | `packages/api/src/modules/replicache/entities.ts` | fetch + serialize `meeting_preps`, prune by `event_start`, row-version diffing |
| Integrations REST | `packages/integrations/src/google/calendar.ts` | add `watchEvents()`, `stopEventsWatch()`, `listEventsDelta(syncToken)` |
| Integrations state | `packages/integrations/src/google/watch.ts` | add calendar watch lifecycle fns beside Gmail (`metadata.calendarWatch`, lookup by channel id, expiring scan) |
| Gather | `packages/api/src/modules/meeting-prep/gather.ts` (new) | deterministic gather + pure testable units; vector recall is additive |
| Compose | `packages/api/src/modules/meeting-prep/compose.ts` (new) | boss-tier `meteredGenerateObject` over the gather; cite only `availableReferences` |
| Store | `packages/api/src/modules/meeting-prep/store.ts` (new) | begin/upsert/status transitions + recompute gate (`material_hash`) |
| Orchestration | `packages/api/src/modules/meeting-prep/index.ts` (new), `packages/api/src/index.ts` | `prepareMeeting(userId, input)` export: resolve event → gate → gather → compose → upsert |
| Tool | `packages/api/src/modules/tools/system.ts` | register `system.prepare_meeting` (`riskTier: "no_risk"`, autonomy) and return `{ok, prepId, status, gate}` |
| Built-in workflow | `apps/server/src/builtins/workflows/meeting-prep.ts` (new), `apps/server/src/builtins/index.ts` | event-trigger wrapper whose only product step calls `system.prepare_meeting` / `prepareMeeting` |
| Webhook | `packages/api/src/modules/integrations/calendar-webhook.ts` (new), `packages/api/src/modules/integrations/index.ts` | unauthenticated Google push receiver; parse `X-Goog-*`, lookup credential by channel, enqueue delta processing |
| Google routes | `packages/api/src/modules/integrations/google-routes.ts` | user-visible install/status/delete routes for calendar watch, separate from Gmail `/:id/watch` if needed |
| Repeatables | `packages/api/src/modules/integrations/repeatable.ts` or a new meeting-prep repeatable module | ~20m horizon sweep + watch-channel renewal; register from `apps/server/src/index.ts` |
| Connect hook | Google OAuth callback path in `google-routes.ts` | install/renew calendar watch when a credential has Calendar scope; failure logs but does not fail OAuth |
| Smoke | `apps/server/src/scripts/smokes/smoke-meeting-prep.ts` (new) | local manual path first; webhook path only with a public HTTPS callback |

## 6. Phased plan (each lands before the next; sub-steps parallel-safe)

### Phase 0 — contracts, schema, sync shape (no runtime behavior)
- Add `MeetingPrepGather` / `MeetingPrepNote` schemas and the parallel resolver:
  `MEETING_PREP_REFERENCE_KINDS = ['meeting','email','todo']`.
- Add `prepareMeetingInput` to `tool-schemas.ts`, `prepare_meeting` to `SYSTEM_ACTIONS`,
  the `TOOL_LABELS` entry, and any tool-field metadata the editor expects.
- Add `calendar.event_scheduled` to `event-triggers.ts`.
- Add `meeting_preps` schema, export it, then run `pnpm db:generate` and
  `pnpm db:migrate`.
- Add the Replicache contract only (`MEETING_PREP` key + zod schema). The server fetcher
  can still be empty until Phase 2, but the type surface is fixed now.

**Exit gate:** resolver unit tests, `pnpm check-types`, and `pnpm check:web-boundaries`.

### Phase 1 — gather (deterministic acceptance first)
- Implement pure units with focused tests:
  `parseEmails`, `matchAttendee`, `selectThreads`, `matchTodos`, `matchMemory`,
  `computeMaterialHash`, `qualifyMeetingEvent`, `eventKeyFor`.
- `selectThreads` scans `documents` where `source='gmail'`, matches attendee emails across
  `metadata.from/to/cc`, groups by `sourceThreadId`, ranks by newest `authoredAt`, and
  cites the newest message as `email:<documentId>`.
- `matchTodos` only reads live rows (`suggested|open` first; include recent `done` only if
  it helps avoid stale prep language) and matches against todo sources, thread ids, and
  attendee emails.
- `matchMemory` has a deterministic entity/fact path plus a separate `memory_chunks`
  recall enrichment. The vector function gets structural tests only: bounded results,
  empty-on-missing-index, no exact-match assertions.
- Gather degrades to empty arrays for missing Gmail corpus / memory / todos. Missing or
  invalid event resolution is the only hard failure.

**Exit gate:** gather tests prove attendee/thread/todo matching and material-hash stability;
no LLM and no Google webhook dependency.

### Phase 2 — manual packet path (demoable before watch)
- Implement `store.ts` as the only writer for `meeting_preps`:
  `beginPrepareMeeting`, `markGathering`, `markComposing`, `markReady`, `markFailed`,
  `markCancelled`, `markTimeOnlyUpdate`, each bumping `rowVersion`.
- Implement recompute gate before compose:
  no row → `full`; failed row → `full`; material hash changed → `full`; only start/end
  changed → update `event_start`/`event_title`, return `time_only`; unchanged ready row →
  `noop`.
- Implement `compose.ts` with boss-tier `meteredGenerateObject`, `MeetingPrepNote` schema,
  and a hard prompt rule: every citation must come from `availableReferences`.
- Implement `prepareMeeting(userId, input)`:
  explicit `eventKey` bypasses qualification; window resolution chooses the soonest timed
  event with `attendees.length >= 2` and user not declined.
- Register `system.prepare_meeting` and return a compact result the chat can show:
  `{ ok, prepId, eventKey, status, gate, resolvedReferences, unresolvedReferences }`.
- Add Replicache server fetch/serializer for ready/in-progress preps within the sync
  window.
- Add `smoke-meeting-prep.ts` for the manual path:
  resolve event → compose row → rerun no-op → re-time cheap path.

**Exit gate:** chat/manual smoke creates a `ready` row, rerun gates correctly, Replicache
pull includes it, `pnpm check-types`, `pnpm check:web-boundaries`, focused api tests.

### Phase 3 — event trigger wrapper (still no external webhook)
- Add a built-in `meeting-prep` workflow with trigger
  `{ kind: 'event', source: 'calendar', type: 'event_scheduled' }`.
- Its state/input is small: `{ eventKey, reason?: 'push'|'sweep'|'manual' }`. The workflow
  calls the Phase 2 orchestration and logs the returned gate.
- Extend `emitEvent`'s bounded context for non-Gmail events: keep `documentId`/`reason`
  behavior for triage, but include `eventId` and safe scalar payload fields such as
  `eventKey` in both `createRun.input` and `trigger.payload`.
- Seed/reseed the builtin for existing users through the existing seeder path.
- Add a direct queue/repeatable helper for local sweep testing that emits
  `calendar.event_scheduled` for qualifying near-term events, then lets the workflow call
  `prepareMeeting`.

**Exit gate:** a local synthetic `emitEvent({ source:'calendar', type:'event_scheduled',
eventId:eventKey, payload:{ eventKey } })` creates exactly one non-duplicate workflow run
and lands on the same `meeting_preps` row as the manual path.

### Phase 4 — proactive producer (calendar watch + sweep)
- `calendar.ts`: add Calendar v3 `events.watch`, `channels.stop`, and
  `events.list(syncToken)` delta helpers. Preserve cancelled events in the delta helper so
  cancellation handling can see them; keep the existing window `listEvents` filtering.
- `watch.ts`: calendar lifecycle helpers:
  `installCalendarWatch`, `uninstallCalendarWatch`, `getCalendarWatchState`,
  `findCalendarWatchByChannelId`, `findExpiringCalendarWatches`.
- Calendar push route: Google sends headers, not a Pub/Sub envelope. Parse
  `X-Goog-Channel-ID`, `X-Goog-Resource-ID`, `X-Goog-Resource-State`,
  `X-Goog-Message-Number`; verify the channel/resource pair against credential metadata;
  return 2xx for stale/unknown channels to avoid retry storms.
- Delta processor: `events.list(syncToken)` → update stored `syncToken` only after a
  successful page drain → for changed qualifying events inside horizon emit
  `calendar.event_scheduled`; for cancelled events `markCancelled(eventKey)`.
- Horizon sweep (~20m): live `events.list(now, now+48h, singleEvents=true)` for active
  Calendar credentials → qualifying events without fresh prep → emit. This is the
  time-passing safety net; push alone is insufficient.
- Watch renewal: renew before `expiresAt`, and install on OAuth connect when Calendar scope
  is present. Renewal must not erase a newer `syncToken`.

**Exit gate:** local sweep path passes without public HTTPS. Webhook path is verified only
with a deployed/tunnel callback and a real Google push channel.

### Phase 5 — observability + QA
- Log a compact audit line at each packet run:
  `prep.gate`, `eventKey`, `eventStart`, `materialHashChanged`, source counts, model id,
  unresolved refs.
- Add smoke coverage:
  manual compose, no-op rerun, time-only rerun, synthetic event-trigger run, sweep run.
- Add manual webhook smoke notes:
  install channel → schedule event inside H → push → prep ready → re-time → cheap path →
  cancel → prep status becomes `cancelled` and leaves the active sync window.

**Exit gate:** one command verifies the local demo spine; webhook smoke is documented
because it depends on a public verified callback.

## 7. Dependencies / ready-for-human

- **Calendar push needs a domain-verified HTTPS callback.** The push channel callback URL's
  domain must be verified in the GCP project (Search Console domain verification) and the
  app deployed at a public HTTPS endpoint. **Local dev can't receive Google push** (no
  localhost callback) → use a tunnel for Phase 3 testing, or test the sweep path (no
  webhook) locally. Phases 0–2 (incl. the demoable chat tool) have **no** such dependency.

## 8. Deferred (own tickets / future ADRs)

- **MEET-002** — delivery surface: pre-meeting email (~N-min before), web augmentation at
  send (`getWebSearchModel`), in-app card polish. The packet is reused; only near-send
  freshness/augmentation is new.
- **UI-001** — citation/source-row UI for the prep surface (interaction grammar).
- **SEARCH-001** — shared evidence/citation layer; promotes memory facts to first-class
  cited provenance (`fact:` kind).
- **CAL-002 mirror** — documents-backed calendar read model; would let the watch maintain a
  mirror and unify the briefing's live read.
- **Multi-calendar watch** — v1 watches `primary` only.

## 9. Rationale

The hard-to-reverse choices (the `meeting_preps` schema + `event_key` wire shape, the
parallel reference enum, the calendar-watch trigger model, the cheap-frequency /
boss-quality split) are recorded in **[ADR-0054](../../decisions.md#adr-0054)**. Read it for
the "why"; this file is the "how/when."

## 10. Open (settle at build time, not now)

- Recency window for `selectThreads` (start at 90d, tune from logs).
- Top-N threads / facts / todos caps in the gather (start small, e.g. 5/5/5).
- Exact `material_hash` field set (attendees + agenda/description + location +
  attachments; exclude start/end/timezone).
- Horizon H (start 48h) and sweep cadence (start ~20m).
- Prune window for `meeting_preps` sync (mirror briefings' 30d, or tighter post-meeting).
