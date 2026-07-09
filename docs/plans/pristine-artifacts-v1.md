# Implementation plan — pristine artifacts (design-system + verified floor)

**Status:** proposed (needs grill + ADR-0083 before build)

**Decision (2026-07-01):** For agent-built decks/docs, optimize **pristine read-only** as the
flagship deliverable, plus a thin **structured→Google Slides escape hatch** for "I want to
edit this in Slides." (Chosen over structured-only and read-only-only.) This reframes
`artifact-native-mirror-v1.md`: its Option B (structured→native) is demoted from *primary*
to the *escape-hatch* lane; this doc is the flagship.

**Builds on:** ADR-0075 artifact system (`packages/contracts/src/artifacts.ts`,
`apps/web/src/components/artifact-page-frame.tsx`, tools `system.create_artifact` /
`append_artifact_page` / `update_artifact`); the `@alfred/mailer` react-email precedent
(agent → markdown → template → styled HTML). No headless Chromium ships today (Elysia on
Railway).

**Recon basis:** Dimension `../-dimension-ai-ai` + `../-dimension-ai-web` (see memory
`project_artifact_document_engine`). Their pristine output = **freehand HTML** + a ~1000-line
design-system prompt (`create_slide` tool description) + a **136-file exemplar library**
(8 themes × 17 layout archetypes) + a bounded-box CDN shell (`slides/template.py`) +
outline-HIL. There is **no automated visual QA loop** — they rely on human eyes → edit. We
borrow the design-system recipe and add the floor they lack.

---

## Principle

1. **The in-app artifact is the guaranteed deliverable** — renders in the sidebar regardless
   of integrations (inherited from `artifact-native-mirror-v1.md`).
2. **Pristine = freehand HTML in an Alfred design system, not structured slots.** Structured
   `{title,bullets,layout}` renders clean but generic; the pristine bar (CSS data-viz,
   micro-textures, 17 layout archetypes) needs freehand HTML + a real exemplar library.
3. **Verified floor.** Every page is fit-checked (deterministic) and optionally
   vision-critiqued, then auto-repaired, before it shows `complete`. This is where we exceed
   Dimension (they ship on human eyeballs).
4. **One typed source of design truth.** A single token module generates the shell, the
   prompt block, and (for docs) Typst variables — no prose duplication/drift (their font
   list drifted across shell + tool-prompt + docstring + plan).
5. **Editable when the user asks.** A separate structured→Google Slides lane (escape hatch),
   template-bounded quality by design, for "edit in Slides."

---

## Architecture

### Flagship lane — pristine read-only

`@alfred/artifacts-design` (new package; web-safe strings + data only, see boundary Q):

- `tokens.ts` — typed design tokens (palette, type scale, spacing, radii, shadow, opacity
  ramps, per-theme font pairings). **Single source of truth.**
- generated **shell** — the CDN head constant (curated fonts + Tailwind + Font Awesome +
  reset + locked `1280×720` body). Agent writes only `<style>` + body; server/renderer wrap
  in the shell. Mirrors Dimension's `template.py`, but generated from `tokens.ts`.
- `themes/` — **Alfred-original** themes (v1: a house theme + 1–2 more), each an exemplar
  HTML library of core layout archetypes (v1 ≈ 6–8: title, section, content-split, list,
  stats/CSS-chart, comparison, quote, image). Built by us on their *principles*
  (bounded-box fit discipline, asymmetric splits, CSS data-viz, micro-texture, exact token
  discipline). **Not copied** — clean IP + the honest "studied their approach, built my own
  system" story.
- `prompt.ts` — the design-system prompt block, generated from tokens/themes (theme
  selection by context, token scale, anti-ugly rules, voice guide incl. no-em-dashes, image
  patterns). Injected into the artifact-authoring turn and **prompt-cached** (per #223 — it's
  identical across every page call; Dimension pays it per slide).

Authoring: the boss (or a dedicated artifact sub-agent / stronger tier — see Q1) authors
freehand `<style>` + body per page against the shell, picking one theme per deck and a
layout archetype per page. Reuses the existing `append_artifact_page` path.

**Verified floor** (new, at finalize):
- **Fit-check (deterministic):** headless-measure the rendered page against the bounded box;
  on overflow, feed the offending element + overflow delta back → bounded auto-`update`
  (≤2 retries). Kills freehand's #1 failure mode (Dimension only *instructs* "no overflow").
- **Vision critique/repair (optional, flag-gated):** screenshot → vision model + theme spec
  + rubric (overflow / contrast / alignment / theme-consistency) → auto-repair on fail.
  Affordable at single-user scale; the primary "exceed" lever.

**Read-only export (download):**
- **Native browser print (shipped, Phase 3a).** Because each page is already a
  self-contained house-shell document with locked geometry, the browser's own print engine
  emits a 1:1 "Save as PDF" with zero new infra: `buildArtifactPrintDocument(pages, format,
  title)` (in `@alfred/artifacts-design`) concatenates every page under the shell styles +
  an `@page`-sized print layer, and `printArtifactPages` (`apps/web/src/lib/artifacts/
  export-artifact.ts`) renders it in an **off-screen, non-sandboxed** iframe and calls
  `print()`. Constraint discovered: the on-screen render iframe is `sandbox=""` (scripts +
  modals blocked), so it cannot print itself — the export must build a fresh unsandboxed
  iframe from the same shell output. Tradeoff: goes through the browser print dialog (not a
  silent one-click file) and fidelity depends on the user's print engine.
- **Documents (`document` kind = markdown) → Typst → PDF** (deferred, Phase 3b). Chromium-free,
  fits Railway, best print typography; doc tokens shared from `@alfred/artifacts-design`.
- **Slides/pages (`pages` kind = HTML) → server PDF/PNG needs a browser** (deferred, Phase 3b;
  Typst cannot render HTML): a **Browserless sidecar** (separate Railway service) or a managed
  HTML→PDF API, screenshot→PDF like Dimension. Only needed when a deterministic, silent,
  server-generated file (e.g. for emailing artifacts) is required — the native print path
  above already covers interactive download. Note: **in-app viewing needs no browser**
  (already renders in the iframe).

### Escape-hatch lane — editable-native Google Slides

The existing `artifact-native-mirror-v1.md` Option B: structured `DeckContent` →
server-built Google Slides `batchUpdate` (Slides is already writable). Triggered when the
user wants to edit in Slides. Template-bounded quality by design (its job is editability,
not pristine). Shares tokens for visual consistency where feasible.

### Docs / sheets

- **Documents:** markdown artifact (styled via the design system's doc styles) + Typst PDF;
  native Google Doc mirror deferred (markdown→Docs is the easiest native path if wanted).
- **Sheets:** table artifact + Google Sheets (already writable) for the editable path.

---

## Phases

**Phase 1 — design-system core (no new infra, biggest quality jump).**
`@alfred/artifacts-design` (tokens → shell + prompt + 1 house theme with ~6 layout
exemplars); wire the prompt block + shell into the artifact-authoring turn; retrofit
`append_artifact_page` to wrap body in the shell. Result: the *existing* in-app artifacts
become pristine, cached, and consistent — zero new services.

**Phase 2a — document medium + authoring floor (shipped).** Live use answered Open Question 1:
the lean prompt carries SLIDES but not DOCUMENTS. Asked for a "resume," the model had no
document exemplar and hand-rolled a page-level `<style>` with hardcoded Apple greys and a
10.5px base — off-brand, cramped, half-empty page. Fix, all deterministic (no model calls):
a `pdf` document is treated as its own medium — a denser `docType` scale + `--art-doc-*` vars
(tokens), an `art-doc-*` primitive layer (shell), and three on-token templates (resume /
report / one-pager) that flow top to bottom and stay balanced. The resume is inlined into
`ARTIFACT_DESIGN_PROMPT` as the anchor. A hard authoring floor backs it: the token system is
the source of truth (reference `var(--art-*)`, never hardcode a palette or font, never drop
below the medium body size), and content is balanced rather than force-filled (no
spacer-to-bottom that strands a mid-page void). `create_artifact`/`append_artifact_page`
descriptions point at the doc vocabulary. Verified by rendering all three templates through
the real shell (caught + fixed a page-fill void); live boss authoring still to confirm.

**Phase 2b — verified floor.** Deterministic fit-check + bounded auto-repair at finalize.
Vision-repair behind a flag. (Was Phase 2; the durable answer to authoring quality once the
templates + floor are exhausted.)

**Phase 3a — native print export (shipped).** Browser-native "Save as PDF" for `pages`
artifacts via `buildArtifactPrintDocument` + an off-screen print iframe; wired into the chat
artifact sidebar and the library viewer's download button. Zero new infra.

**Phase 3b — server-generated export (deferred).** Typst PDF for markdown documents
(Chromium-free). Browserless sidecar for HTML slide→PDF when a deterministic, silent,
server-side file is needed (beyond the native print dialog).

**Phase 4 — editable escape hatch.** Structured→Google Slides (folds in
`artifact-native-mirror-v1.md` Option B) + the guaranteed-artifact / honest-fallback prompt
rule.

**Phase 5 — breadth.** More themes + layout archetypes (toward Dimension's 8×17), sheets/docs
native mirrors.

---

## Acceptance

- "Make me a 4-slide deck on X" → a pristine, on-theme, fit-checked artifact deck in the
  sidebar (one theme, no overflow), from the design system — not per-turn ad-hoc CSS, not two
  blank Google decks.
- Overflowing content is auto-repaired (fit-check) before the deck shows `complete`.
- "I want to edit this in Google Slides" → a populated (not blank) editable deck via the
  structured lane.
- Markdown report → download → Typst PDF, no Chromium.
- Design tokens live in one module; shell + prompt are generated from it (no drift).
- `pnpm check-types` green; `pnpm check:web-boundaries` respected.

---

## Open questions for grill

1. **Authoring altitude.** Can Haiku 4.5 (current boss, ADR-0077) author dark-tech-quality
   freehand HTML, or does the artifact-authoring step need Sonnet / a dedicated sub-agent?
   (The blank-deck bug was Haiku.) The design-system prompt + exemplars + fit/vision-repair
   exist precisely to lift a smaller model — but quality-vs-cost needs a call.
2. **Vision-repair in v1 or flag-gated later?** Cost/latency vs the biggest exceed lever.
3. **Outline-HIL** (Dimension's `propose_outline`) for multi-slide decks in v1? Quality gate
   + user control vs an added step.
4. **A structured `deck` variant for the pristine lane too** (for cheap re-skinning /
   author-once), or freehand-HTML-only for simplicity?
5. **Browser for slide-PDF:** Browserless sidecar (self-host on Railway) vs a managed
   HTML→PDF API. (Docs use Typst regardless.)
6. **Package boundary:** `@alfred/artifacts-design` — shell/prompt/themes/tokens are pure
   strings/data (web-safe); Typst/Browserless drivers are server-only. Split so `apps/web`
   never imports the server bits (`check:web-boundaries`).
7. **ADR-0083 scope:** one ADR covering both lanes (this doc = flagship; `artifact-native-
   mirror-v1.md` = escape-hatch lane), superseding the "populate-on-create" line in ADR-0043's
   plan. Confirm.

---

## Recommend

**ADR-0083 — pristine artifacts via a design-system + verified floor** (freehand-HTML
flagship + structured-native escape hatch). Supersedes the "populate-on-create" line in
ADR-0043's plan; reframes `artifact-native-mirror-v1.md` as the escape-hatch spec.
