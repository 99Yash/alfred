# Artifact sidebar v1 — implementation plan (ADR-0075 design)

Status: **in progress** (branch `feat/artifact-sidebar`, worktree off `main`).
Promotes **ADR-0075** from _FRAMED — DEFERRED_ to _designed + built_.

The agent generates artifacts (documents, slide/PDF pages) and the web app renders
them inline in a resizable right-side sidebar — agent-authored HTML/markdown stored
in-house, **not** Google→PDF export. UX target: `-dimension-ai-web`'s artifact sidebar.

---

## The one decision that shapes everything: streaming granularity

Dimension streams **partial tool-call JSON** (slide content token-by-token) into the
sidebar via its tRPC run stream. **Alfred cannot do this today**: the chat SSE stream
(`chat.tool` events, `packages/schemas/src/events.ts`) only carries a tool call as
`started` (full `argsPreview`, capped 2000 chars) and `succeeded`/`failed`
(`resultPreview`, capped 2000 chars). There is no partial-args delta channel, and the
2000-char cap means artifact content can never ride the tool-call payload anyway.

**v1 decision — content in a synced row, streaming at page granularity.**

- Artifact content lives in a **synced `artifacts` row** (Postgres → Replicache),
  written **complete** per the entity recipe (rows are never partial; live updates
  ride pokes).
- The boss authors incrementally: `create_artifact` (opens the artifact) then N ×
  `append_artifact_page` / one `update_artifact`. **Each tool call writes/updates the
  row and emits a Replicache poke**, so a new page/section appears in the sidebar as
  the boss produces it. That is "streamed during generation" at **page/step**
  granularity.
- The sidebar **auto-opens in a `generating` state** the moment a `system.create_artifact`
  tool call `started` event arrives (we already get `toolName` + `argsPreview` with the
  title), then renders real content as the synced row lands.

**Deferred (not v1):** token-level streaming. Would need a new `chat.artifact-delta`
SSE event kind feeding an ephemeral preview buffer (mirror of `use-chat-stream.ts`).
Called out so the v1 store/types leave a seam for it. This is the single honest
divergence from dimension's UX and the owner should confirm it's acceptable before
Phase 4 polish.

---

## v1 scope

**In:**
- Artifact kinds: **`document`** (markdown) and **`pages`** (ordered HTML pages;
  `format: "slides" | "pdf"` drives aspect ratio/styling). `pages` reuses the existing
  `ArtifactPageFrame` (scaled sandboxed `<iframe srcDoc>`, ResizeObserver) — already in
  the repo at `apps/web/src/components/artifact-page-frame.tsx`.
- Synced `artifacts` entity (standard Replicache recipe).
- Boss tools: `system.create_artifact`, `system.append_artifact_page`,
  `system.update_artifact`.
- Live `/chat` integration: resizable right sidebar (drawer on mobile), trigger card in
  the assistant message, open/close/resize (width persisted), page thumbnails +
  fullscreen presentation mode.
- "Suggest an edit in chat" → boss calls `update_artifact` (re-renders in place).

**Out (deferred, with seams left):**
- `spreadsheet` kind (needs Univer — heavy commercial dep). Type union includes it but
  no renderer/tool ships.
- Token-level streaming (above).
- True in-place WYSIWYG editing (v1 edits go through the chat → `update_artifact`).
- R2 storage — v1 content is Postgres-only (markdown text + HTML strings as jsonb). R2
  (ADR-0065 infra) is only needed for heavy binary, which v1 never produces. Schema
  leaves a nullable `storage_key` seam.

---

## Data model

`packages/db/src/schema/artifacts.ts` — new table `artifacts`:

| column        | type                                   | notes                                              |
|---------------|----------------------------------------|----------------------------------------------------|
| `id`          | `text` PK `$defaultFn(createId("art"))`|                                                    |
| `user_id`     | `text` notNull → `user.id` **cascade** |                                                    |
| `thread_id`   | `text` notNull → `chat_threads.id` cascade | which chat produced it                         |
| `run_id`      | `text` → `agent_runs.id` **set null**  | authoring run                                      |
| `message_id`  | `text` → `chat_messages.id` **set null**| assistant message that authored it (for the card) |
| `kind`        | `text` `$type<ArtifactKind>`           | `document` \| `pages` \| `spreadsheet`(reserved)   |
| `format`      | `text` `$type<ArtifactFormat>` null    | for `pages`: `slides` \| `pdf`                     |
| `title`       | `text` notNull                         |                                                    |
| `status`      | `text` `$type<ArtifactStatus>`         | `generating` \| `complete` \| `error`              |
| `content`     | `jsonb` `$type<ArtifactContent>`       | `{markdown}` or `{pages:[{title,html}]}`           |
| `storage_key` | `text` null                            | R2 seam (unused v1)                                |
| `row_version` | `integer` notNull default 0            | **sync signal — bump on every write**              |
| `...lifecycle_dates`                                   | `created_at`, `updated_at`         |

Indexes: `(user_id)`, `(thread_id, created_at)`, `(run_id)`.

Types live in `@alfred/contracts` (source of truth), DB binds via `.$type<>()`, sync
schema derives via `z.infer`. **No hand-rolled duplicate shapes** (code-style rule).

Migration: `db:generate` → `db:migrate`. **Never `db:push`.**

---

## Phases (dependency-ordered, each independently verifiable)

### Phase 1 — substrate (no UI, no model) ✅ _done + verified_
1. `ArtifactKind`/`ArtifactFormat`/`ArtifactStatus`/`ArtifactContent` types + zod in
   `@alfred/contracts`.
2. `artifacts` Drizzle table + generated migration.
3. `syncedArtifactSchema` + `SyncedArtifact` type (`@alfred/sync`).
4. `IDB_KEY.ARTIFACT`, client mutators (`artifactUpsertClient`), registration.
5. Server `ENTITY_FETCHERS.ARTIFACT` + serializer; server mutator.
6. Client hooks `useArtifacts(threadId)`, `useArtifact(id)`.
- **Verify:** `pnpm check-types`, `pnpm check:web-boundaries`; a scripted insert →
  pull round-trip shows the row arrive on the client.

### Phase 2 — authoring tools (model can produce, still no sidebar)
1. Add `create_artifact` / `append_artifact_page` / `update_artifact` to
   `INTEGRATION_ACTIONS.system` + `TOOL_LABELS` in `@alfred/contracts`.
2. `liveTool` defs in `packages/api/src/modules/tools/system.ts`; `execute` resolves
   `threadId` from the run, writes/updates the `artifacts` row, bumps `row_version`,
   `emitReplicachePokes([userId])`. Returns a small `{artifactId,title,kind}` result
   (well under the 2000-char preview cap).
3. Boss-prompt rubric: when asked to "make a doc/slides/PDF", call these instead of the
   ADR-0071 bridge (share-a-Google-link). Lead with tool descriptions, not prompt
   patches (per the no-prompt-patching-for-tool-selection lesson).
- **Verify:** replay-diff a recorded "make me a one-pager" run old vs new build; assert
  the new trajectory calls `create_artifact` and a row lands. (replay-diff per the
  agent-change-verification lesson, not an aggregate eval.)

### Phase 3 — sidebar UI on live `/chat`
1. Promote the static `ArtifactPanel` (today only in the styleguide, fed by
   `SYCAMORE_BRIEF_PAGES`) into a real component reading a `SyncedArtifact`.
2. Renderers: `document` → markdown renderer (existing `markdown-renderer.tsx`);
   `pages` → `ArtifactPageFrame` thumbnails + viewer; fullscreen presentation mode
   (port dimension's keyboard-nav + postMessage font-ready signal).
3. Resizable layout in `chat-shell.tsx` (sibling to the existing `RightRail`); width +
   open/closed persisted to `localStorage`. Mobile = drawer (Radix Dialog).
4. Trigger card in the assistant message when a `create_artifact` tool call is present
   → opens the sidebar to that artifact.
- **Verify:** `/run` skill — author an artifact in live chat, see it render; resize,
  fullscreen, reload (renders from synced row).

### Phase 4 — generating state + edit-in-chat + polish
1. Auto-open `generating` state off the `chat.tool` `started` event for
   `system.create_artifact`; pages stream in per poke.
2. "Suggest an edit" affordance → composer prefill → boss `update_artifact` →
   re-render.
3. Animations (enter/resize), error/empty states, a11y (focus trap in drawer, Escape).
4. Decide token-level streaming (the deferred fork) — only if the page-granular UX
   feels insufficient in practice.

---

## Stack mapping (dimension → Alfred)

| dimension                              | Alfred                                                        |
|----------------------------------------|---------------------------------------------------------------|
| Zustand + immer store                  | Replicache synced entity + a small local UI store (open/width/selected) |
| tRPC `artifacts.*` queries             | `useArtifacts`/`useArtifact` Replicache hooks                 |
| partial-json streaming of tool args    | **page-granular** writes + pokes (no token stream in v1)      |
| Univer spreadsheet                     | **deferred**                                                  |
| `re-resizable`                         | reuse if already a dep, else a small CSS-resize handle        |
| `framer-motion`                        | prefer existing CSS animation utilities in `index.css`        |
| iframe slide/PDF card                  | existing `ArtifactPageFrame` (already token-for-token this)   |
| content in their DB + preview URLs     | content in `artifacts.content` jsonb (Postgres), R2 seam      |

---

## Open questions to confirm

1. **Streaming granularity** (page-level v1 vs token-level later) — the one visible UX
   divergence from dimension. Plan assumes page-level for v1.
2. **New deps:** add `re-resizable`/`framer-motion`, or build resize + motion on the
   existing CSS-utility stack? Lean: no new deps for v1.
3. **`pages` authoring ergonomics:** does the boss emit full per-page HTML (heavier
   tokens, full control) or structured blocks we template into HTML (cheaper, less
   control)? Lean: full HTML per page for v1 (matches dimension; simplest renderer).
