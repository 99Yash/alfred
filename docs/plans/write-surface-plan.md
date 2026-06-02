# Implementation plan — write surface + user-controlled permissions

Implements ADR-0043 (write surface gated by user action policy), ADR-0044 (OAuth
posture: multi-tenant-capable, Production-unverified, least-privilege scopes), and
the 2026-05-27 ADR-0034 amendment (chat auto-mode + per-app Workspace tool slugs).

**Scope of this plan:** the permissions + write-scope work. The chat→`AlfredAgent`
runtime bridge (driving a run from the composer, streaming tool calls, inline
approval cards) stays parked under m13 — see "Parked / m13-dependent" at the end.

The backend permission engine (ADR-0034: `user_action_policies`, `action_stagings`,
the dispatcher policy gate, durable HIL pause/resume,
`/api/approvals/:stagingId/decision`) already exists. Most of this plan is
**adding write tools to gate** and **wiring the fixture UIs to that engine** — not
new architecture.

---

## Phase 0 — Contracts + scopes (foundation, no runtime risk)

**0a. `packages/contracts/src/tools.ts`**
- Add `sheets`, `slides` to `LOADABLE_INTEGRATION_SLUGS`.
- Populate the empty action lists and add the two new ones:
  - `DRIVE_ACTIONS = ['share']` (file creation lives under the per-app slugs).
  - `DOCS_ACTIONS = ['create']`, `SHEETS_ACTIONS = ['create']`, `SLIDES_ACTIONS = ['create']`.
  - Wire `sheets`/`slides` into `INTEGRATION_ACTIONS`.
- (Content-edit actions — `slides.add_slide`, `sheets.append_row`, `docs.append` —
  are deferred; `create` + populate-on-create covers "make me a deck/doc/sheet".)

**0b. `packages/integrations/src/google/oauth.ts` — least-privilege scope set (ADR-0044 table)**
- Scope constants: keep `GMAIL_MODIFY_SCOPE` (restricted concession, already present)
  and `GMAIL_SEND_SCOPE`; add `DRIVE_FILE_SCOPE` (`drive.file`),
  `CALENDAR_EVENTS_SCOPE` (`calendar.events`), `DOCUMENTS_SCOPE`,
  `SPREADSHEETS_SCOPE`, `PRESENTATIONS_SCOPE`.
- Rewrite `GOOGLE_FEATURE_SCOPES` to the least-privilege mapping. Drop the
  `*.readonly` Workspace scopes and `gmail.readonly` (subsumed by `gmail.modify`);
  swap `calendar.readonly` → `calendar.events`; add the create-tool features
  (`docs`/`sheets`/`slides` → `drive.file`; the broad `documents`/`spreadsheets`/
  `presentations` stay defined but unmapped until a cross-file-edit tool needs them —
  ADR-0044 "power tier", default off).
- `scopesForFeatures(undefined)` keeps returning the full union (the "grant all" /
  default connect path) — now a least-privilege union.

**0c. `packages/integrations/src/google/scopes.ts` — scope-superset map**
- `requireScopes` currently exact-matches strings, so a `gmail.modify` grant fails a
  `gmail.readonly` requirement. Add a `SCOPE_SUPERSETS` map and normalize `granted`
  before the `missing` filter: `gmail.modify ⊇ gmail.readonly`; `calendar ⊇
  calendar.events ⊇ calendar.readonly`; `drive ⊇ drive.readonly ⊇ drive.file`;
  `documents ⊇ documents.readonly` (and sheets/slides equivalents).
- This keeps existing read-path features (`briefing`/`triage`) satisfied by the new
  broader grants without rewriting their feature→scope rows.
- Keep identity scopes exact. The superset map is only for capability scopes; do not
  let a broad product scope satisfy `openid` / `userinfo.email`.

**0d. Dispatcher override slot (no thread table assumption)**
- `packages/api/src/modules/action-policies/resolve.ts`: keep durable policy resolution
  as-is, but expose a helper/signature that accepts an optional run-scoped
  `PolicyMode` override.
- `packages/api/src/modules/dispatch/index.ts`: add an optional `policyModeOverride`
  (or equivalent) to `DispatchArgs`. If present, it wins above per-tool /
  per-integration / default. `system.*` still stays autonomy.
- Do **not** add a thread/conversation table in this plan. The m13 chat bridge will copy
  the server-authoritative thread auto-mode value onto the run before dispatch.

**0e. Tool exposure boundary check**
- Do not duplicate the active-integration gate in the dispatcher today. Current
  enforcement is: `resolveSdkTools(state.activeIntegrations)` exposes only loaded
  integration tools, and `system.load_integration` enforces `workflows.allowed_integrations`
  before adding a slug. A future generic dispatch endpoint would need a separate
  dispatcher-side active-integration check because it could bypass SDK tool exposure.

**Acceptance:** `pnpm check-types` green; `scopesForFeatures()` returns the ADR-0044
set; a credential granted `gmail.modify` passes `requireScopes(id, ['briefing'])`;
a run override of `autonomy` executes a normally-gated tool without mutating
`user_action_policies`.

---

## Phase 1 — Google write drivers + tools

**1a. Drivers — `packages/integrations/src/google/{drive,docs,sheets,slides}.ts`**
- Thin REST clients mirroring the existing `calendar.ts`/`gmail.ts` shape, using
  `getFreshAccessToken(credentialId)`.
- `drive.ts`: `createFile({ mimeType, name })` and `getFileMetadata({ fileId })`.
  Docs/Slides create responses do not reliably carry `webViewLink`, so normalize by
  fetching Drive metadata (`fields=id,name,mimeType,webViewLink`) after creation.
  Add `shareFile(...)` for the explicit `drive.share` tool.
- `docs/sheets/slides.ts`: `create({ title, ...content })` — create via the app's API
  (or Drive + mimeType), optionally populate via `batchUpdate`. `drive.file` authorizes
  the editor APIs for app-created files, so no broad scope needed.

**1b. Tools — `packages/api/src/modules/tools/{drive,docs,sheets,slides}.ts`**
- Register `docs.create`, `sheets.create`, `slides.create` (`riskTier: 'low'`,
  return `{ fileId, webViewLink }`), `drive.share` (`riskTier: 'high'`).
- Each `execute` calls `requireScopes(credentialId, [feature])` first → surfaces
  `MissingScopesError` as the re-consent CTA.
- Wire the existing stubs: `gmail.send_draft`, `calendar.list_events`, and
  `calendar.create_event` currently `throw` in the tool modules even though the
  integrations package already has a Calendar read client. Implement them against the
  drivers now that the pattern is proven.
- Register all in the boot path alongside `gmailTools`/`calendarTools`.

**Acceptance:** a gated `slides.create` dispatch stages an `action_stagings` row;
approving it (via the API) creates a real deck and writes `webViewLink` to
`execute_result`. No auto-share.

---

## Phase 2 — Policy-mutation endpoint + settings editor (the real backend gap)

**2a. `packages/api/src/modules/action-policies/routes.ts` (new)**
- `GET /api/me/action-policy` → resolved policy (default_mode, integration_rules,
  approval_notify_delay_ms).
- `PUT /api/me/action-policy` → upsert `user_action_policies`; **must call
  `publishPolicyBust(userId)`** so the dispatcher's in-process cache invalidates over
  Redis. Mount the Elysia route group.

**2b. Settings UI — `apps/web/src/routes/settings.tsx` (currently a fixture page)**
- Per-integration card with the ADR-0034 radio: **Full autonomy / Gated** (no
  per-tool tier — deferred per ADR-0034). Read/write through the new endpoint.
- Update `apps/web/src/lib/integrations.ts` copy for Drive/Docs/Sheets/Slides. It still
  says those integrations are read-only; after this plan, creation and explicit sharing
  exist and must not be represented as read-only grants.

**Acceptance:** flipping `gmail` to `autonomy` in settings makes a subsequent
`gmail.send_draft` execute without staging; flipping back re-gates it (cache bust
verified across a fresh dispatch).

---

## Phase 3 — Approvals UI wiring

- `/approvals` and the `approval-card` components exist on fixtures ("stateful no-ops").
- The Replicache entity already exists: `IDB_KEY.ACTION_STAGING`,
  `syncedActionStagingSchema`, and the `ACTION_STAGING` fetcher in
  `packages/api/src/modules/replicache/entities.ts`.
- Replace the fixture local state with pending rows from Replicache and POST decisions
  to the existing `POST /api/approvals/:stagingId/decision`.
- UI labels map onto existing API decisions:
  - **Approve** → `{ decision: "approve" }`
  - **Approve with edits** → `{ decision: "approve", editedInput }`
  - **Reject with reason** → `{ decision: "reject", reason }`
  - **Reject and end run** → `{ decision: "cancel_run", reason }`

**Acceptance:** a gated tool call surfaces a real card in `/approvals`; approving it
resumes the parked run and executes; rejecting synthesizes the rejection tool-result.

---

## Phase 4 — Connect "grant all" UX

- `apps/web` integrations surface: "Connect Google" hits `/api/integrations/google/connect`
  with no `?features=` → full least-privilege union in one consent.
- Current detail CTAs deliberately narrow Gmail and Calendar (`?features=...` in
  `components/preview/integrations/detail-header.tsx`). Change those to the unified
  no-feature Google connect path unless a later screen intentionally presents
  incremental re-consent as an advanced action.
- Surface `MissingScopesError` (code `MISSING_SCOPES`) as a re-consent CTA carrying
  `features`.

**Acceptance:** connecting from a clean state requests the ADR-0044 scope set in one
Google consent; an already-connected user re-consents in place (`include_granted_scopes`).

---

## Phase 5 — GCP Production flip (manual, no code)

- Flip the OAuth consent screen **Testing → Production** (unverified) in GCP Console.
- Re-consent the owner account once (clears the warning for that account and gets a
  refresh token outside Testing mode's 7-day expiry; the token is still revocable and
  subject to Google's normal token limits).
- Add the "to go public" checklist alongside ADR-0044 (verify sensitive scopes
  + restricted-scope security assessment for `gmail.modify` + remove ADR-0009
  allowlist), per ADR-0044.

---

## Ordering & parallelism

```
Phase 0 ─▶ Phase 1 ─▶ (verify gated write end-to-end)
   │
   ├─▶ Phase 2  (independent)
   ├─▶ Phase 3  (independent)
   └─▶ Phase 4  (independent)
Phase 5 after Phase 0 ships (so re-consent grabs the new scopes).
```

Phases 2 / 3 / 4 are independent of Phase 1 and of each other.

---

## Parked / m13-dependent (chat→runtime bridge)

Tracked here so it isn't lost; **not** part of this plan's scope.

- **Dispatcher resolution order** already gains the slot now: `run-scoped auto-mode
  override → per-tool → per-integration → default`. The dispatcher can accept the
  run-scoped override parameter before any UI exists.
- **Chat auto-mode wiring** — needs a **thread/conversation entity** (no such table
  today) to store the server-authoritative per-thread override. The composer's
  `autoMode` toggle (`dimension-chat-thread.tsx`) is local `useState`; wiring it means:
  seed default from localStorage/global store (default **manual**), persist onto the
  thread row on first send, dispatcher reads it per run.
- **Inline approval card in the chat thread** (vs. the standalone `/approvals` page).
- All of the above land with the m13 chat→`AlfredAgent` run wiring (ADRs 0026/0040).
