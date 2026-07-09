# Implementation plan — artifact-first deliverables + native Workspace mirror

**Status:** proposed (needs ADR + grill before build)
**Trigger:** 2026-07-01. User asked Alfred (Haiku 4.5 boss) "create me a presentation for
HNSW indexes, ~4 slides." Alfred created **two blank** Google Slides decks
(`slides.create_presentation` ×2), never populated them, falsely told the user "I can't
populate the slides directly right now," and fell back to an artifact deck. It also fired
`append_artifact_page` before `create_artifact` (the one "step failed" banner).

Root cause is **not** scope (the credential has full `.../auth/presentations` write) and
**not** a missing tool (`slides.batch_update` exists). It is that populating a deck requires
hand-authoring raw Slides API `batchUpdate` request objects (`createSlide` + `insertText`
with generated placeholder object IDs) — an expert task with zero scaffolding. A small
model won't attempt it, so it gives up.

Separately fixed already (2026-07-01, not part of this plan): the artifact slide iframe
scrollbar — `apps/web/src/components/artifact-page-frame.tsx` now prepends a `box-sizing:
border-box` + `overflow:hidden` reset to the `srcDoc` so model HTML (`body{height:100vh;
padding}`) can't overflow the fixed 720px page and leak a non-operable scrollbar (the
iframe is `pointer-events-none`).

---

## Principle (the user's requirement, restated)

1. **The artifact is the guaranteed deliverable.** Whatever the user asks to be written or
   built — deck, doc, sheet — must always render in the right-side panel, even if no
   integration is connected or the native mirror errors. The artifact never depends on
   Google.
2. **The native Workspace file is a best-effort mirror.** When the relevant integration is
   connected, Alfred also produces a real Google Slides/Docs/Sheets file from the *same*
   content. If that fails, the artifact still stands and Alfred says plainly that the
   Drive copy didn't go through.
3. **No small model authors raw Google API request objects.** Populate tools take
   *structured content*; the server builds the `batchUpdate`.

This generalizes the write-surface intent (ADR-0043/0044, `write-surface-plan.md` lines
27-28, 89-90) which explicitly wanted "create + populate-on-create" but only ever shipped
bare `create` + raw `batch_update`.

---

## Design fork (the decision to grill)

### Option A — pragmatic: author twice (artifact HTML + structured native)
The boss authors the artifact deck as HTML pages (as today), and *separately* calls a new
high-level `slides.create_deck({ title, slides:[{title,bullets}] })`. Two authoring passes.
- **Pros:** smallest change; artifact renderer untouched; ships fast.
- **Cons:** Haiku authors the same deck twice (cost + latency + drift between the inline
  artifact and the Drive file); exactly the redundant work small models do worst.

### Option B — target: author once (structured) → render many  ✅ recommended
The boss authors **one** structured deck (`[{title, bullets, layout?}]`). The server renders
it two ways: (a) into artifact `pages` HTML via a fixed template, (b) into a Slides
`batchUpdate`. Same source, no drift, one authoring pass.
- **Pros:** single source of truth; no double authoring; matches the "author once, render
  many" / self-syncing-agent direction; a consistent house slide style instead of
  per-turn model CSS (also retires the scrollbar class of bug entirely).
- **Cons:** touches the artifact content model — `pages` gains a structured variant (or a
  new `deck` kind) and a server/client template renderer; larger, needs an ADR.

**Recommendation:** B for slides and docs (where structured content maps cleanly), keep the
raw `batch_update` escape hatch for power edits. This is a new ADR (proposed **ADR-00NN:
artifact-first deliverables with a structured-content native mirror**), superseding the
"populate-on-create" line items in ADR-0043's plan.

---

## Scope by surface (v1)

| Surface | Native write today | v1 work |
|---|---|---|
| **Slides** | create + raw batch_update + add_slide | `slides.create_deck(structured)` → create + internal batchUpdate. Primary fix. |
| **Docs** | **none (read-only)** | new native write path is a real lift; v1 = artifact-only doc, mirror deferred. Document the gap. |
| **Sheets** | create + update_values (`CellValue[][]`) + batch_update | already structured enough; add a thin `sheets.create_with_values({title, values})` convenience; artifact = table render. |

v1 delivers the **Slides** path end to end (the reported bug), plus the guaranteed-artifact
prompt rule for all three. Docs native-write and full author-once unification are phased.

---

## Phases

**Phase 1 — structured slide content + renderers (Option B core)**
- `packages/contracts`: a `DeckContent` schema — `slides: [{ title, bullets: string[],
  layout?: "title"|"title_body"|"section" }]`, capped (≤100 slides, bullet/char limits).
  Use `coerceJsonArrayFields` for the Haiku stringified-array quirk.
- Server template: `DeckContent → ArtifactPage[]` (HTML) using one house style (fixed
  1280×720, safe box model — no model CSS). Wire into the artifact write path.
- `packages/integrations/src/google/slides.ts`: `buildDeckRequests(DeckContent) →
  Slides API requests`; `createDeck({accessToken,title,content})` = create + batchUpdate.

**Phase 2 — high-level tool + guaranteed artifact + honest fallback**
- `slides.create_deck` tool (`packages/api/src/modules/tools/slides.ts`, contracts schema,
  `INTEGRATION_ACTIONS`): structured input, `requireScopes` first.
- Boss prompt (`chat-turn.ts` line 202 block): "a deck/doc/sheet is authored as an artifact
  **first** (always renders); if the matching integration is connected, also produce the
  native file from the same content; if that errors or isn't connected, the artifact stands
  and you say the Drive copy didn't go through. Never author the same deck twice; never call
  `create_presentation` then stop."
- Guard: dedupe repeated `create_presentation`/`create_deck` in one turn; keep the existing
  append-before-create failure honest (already surfaced).

**Phase 3 — generalize (docs native write, sheets convenience, author-once for docs)**
- Docs native write driver + `docs.create_document(markdown)`; markdown→Docs batchUpdate.
- Sheets `create_with_values`; artifact table renderer for the sheet.

---

## Acceptance
- "Make me a 4-slide deck on X" with Slides connected → one populated Google deck (not two
  blank ones) **and** an inline artifact deck, from one authoring pass.
- Same request with Slides disconnected or the API erroring → the artifact still renders and
  Alfred states the Drive copy didn't go through.
- No raw Slides `batchUpdate` JSON authored by the model on the happy path.
- `pnpm check-types` green; a triage/eval-safe smoke on the Slides path.

---

## Open questions for grill
1. Option A vs B (double-author vs author-once). Recommendation: B.
2. Does the artifact deck keep model-authored HTML pages as an option, or move fully to the
   structured house template? (Full move retires the scrollbar bug class but reduces
   layout freedom.)
3. Docs native write in v1 or deferred? (No write path exists today — real lift.)
4. New ADR number + does this supersede the "populate-on-create" lines in ADR-0043's plan?
