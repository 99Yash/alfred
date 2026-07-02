# Implementation plan — pristine artifacts (design-system + client-verified floor)

**Status:** grilled 2026-07-01 (12 decisions locked); recommends **ADR-0083** before build.

**Decision (2026-07-01):** For agent-built decks/docs, optimize **pristine read-only** as the
flagship deliverable, plus a thin **structured→Google Slides escape hatch** for "I want to
edit this in Slides." (Chosen over structured-only and read-only-only.) This reframes
`artifact-native-mirror-v1.md`: its Option B (structured→native) is demoted from *primary*
to the *escape-hatch* lane; this doc is the flagship.

**Builds on:** ADR-0075 artifact system (`packages/contracts/src/artifacts.ts`,
`apps/web/src/components/artifact-page-frame.tsx`, tools `system.create_artifact` /
`append_artifact_page` / `update_artifact`); the `@alfred/mailer` react-email precedent
(agent → markdown → template → styled HTML).

**Recon basis:** Dimension `../-dimension-ai-ai` + `../-dimension-ai-web` (see memory
`project_artifact_document_engine`). Their pristine output = **freehand HTML** + a ~1000-line
design-system prompt (`create_slide` tool description) + a **136-file exemplar library**
(8 themes × 17 layout archetypes) + a bounded-box CDN shell (`slides/template.py`) +
outline-HIL. There is **no automated visual QA loop** — they rely on human eyes → edit. We
borrow the design-system recipe and add the floor they lack, adapted to Alfred's stack.

---

## What the grill changed (read this before the old body)

The 2026-07-01 grill walked all 7 original open questions plus five the plan didn't name and
locked 12 decisions. The material shifts from the first draft:

1. **Authoring altitude — follow the picker, no model gating.** Artifacts author on whatever
   chat tier is active (Haiku 4.5 on Auto, ADR-0077). We bet quality on the scaffold, not a
   stronger model. No dedicated Sonnet sub-agent, no forced tier bump. (Rationale: the whole
   point of borrowing Dimension's recipe is that the scaffold lifts a small model; Alfred
   moved to Haiku *for cost* on the 87%-of-spend path; a sub-agent adds `threadId` plumbing +
   join latency for unproven benefit. The client floor makes the small-model bet safe.)
2. **Verified floor is client-measured, not server-headless.** The deterministic fit-check
   runs in the *user's* browser (the iframe becomes scriptable and posts overflow back), so
   it needs **no server Chromium** and ships in v1. This removes the first draft's hidden
   ordering bug (a "deterministic fit-check" that secretly needed the Chromium the plan
   deferred to Phase 3).
3. **Vision-repair defers to the export phase.** It needs a *screenshot* the client can't
   produce from a sandboxed iframe (tainted cross-origin canvas), so it rides in with the
   in-house Chromium that export needs anyway — flag-gated, not v1.
4. **One render engine — Chromium, not Typst.** Q10 committed in-house Chromium for slide
   export, which knocks out Typst's "Chromium-free" rationale. Typst would also need its own
   `tokens→Typst` binding — a *third* design target that fights the one-shell-source
   principle. Docs render markdown → design-system HTML → the same Chromium. Typst is a
   documented future option if long-form print typography becomes a felt gap.
5. **Design system rides in as the `create_artifact` result (progressive disclosure), not in
   every turn's tool description.** Pays the ~1000-line cost only on turns that author an
   artifact — never on the 87% that don't — and puts the scaffold freshly in front of Haiku
   at the exact moment of authoring.
6. **Shell is render-time-injected; pages become shell-dependent** (amends the ADR-0075
   self-contained-page invariant). Token-generated base CSS + self-hosted subset fonts +
   inline SVG icons, one shell source for view and export. No CDN, no full Tailwind.
7. **Export is in-house only** (managed HTML→PDF SaaS and browser-use rejected on privacy —
   the artifact carries the user's private content). On-demand Playwright/Puppeteer *inside
   the existing server process* (workers are co-hosted with the API today); split into a
   dedicated export worker only if Chromium's memory spike ever threatens the co-hosted
   workers.

---

## Principle

1. **The in-app artifact is the guaranteed deliverable** — renders in the sidebar regardless
   of integrations (inherited from `artifact-native-mirror-v1.md`).
2. **Pristine = freehand HTML in an Alfred design system, not structured slots.** Structured
   `{title,bullets,layout}` renders clean but generic; the pristine bar (CSS data-viz,
   micro-textures, layout archetypes) needs freehand HTML + a real exemplar library.
3. **Client-verified floor.** Every page is fit-checked *in the browser* (deterministic) and
   auto-repaired via an invisible background pass before it shows `complete`. Vision-critique
   is a flag-gated fast-follow once the export browser lands. This is where we exceed
   Dimension (they ship on human eyeballs).
4. **One typed source of design truth.** A single token module generates the shell and the
   design-system prompt — no prose duplication/drift (their font list drifted across shell +
   tool-prompt + docstring + plan). One shell source wraps both the in-app render and the
   Chromium export.
5. **Editable when the user asks.** A separate structured→Google Slides lane (escape hatch),
   template-bounded quality by design, for "edit in Slides."

---

## Architecture

### Flagship lane — pristine read-only

`@alfred/artifacts-design` — a **pure, entirely web-safe package** (tokens + shell + prompt +
exemplars, all strings/data, zero Node deps; both `apps/web` and `@alfred/api` import it
freely, so `check:web-boundaries` is satisfied by construction). Export drivers live in the
API module (`packages/api/src/modules/artifacts/export/`), never in this package.

- `tokens.ts` — typed design tokens (palette, type scale, spacing, radii, shadow, opacity
  ramps, per-theme font pairings). **Single source of truth.**
- generated **shell** — the head/style constant injected at render time (token-generated base
  CSS + self-hosted subset fonts + inline SVG icons + reset + locked `1280×720` body). The
  agent writes only page-specific `<style>` + body; the renderer (client) and the exporter
  (server) both wrap it in the *same* shell. Extends the existing `PAGE_RESET` prepend in
  `artifact-page-frame.tsx`. **No CDN / no full Tailwind.**
- `themes/` — **Alfred-original** themes (v1: a house theme + 1–2 more), each an exemplar
  HTML library of core layout archetypes (v1 ≈ 6–8: title, section, content-split, list,
  stats/CSS-chart, comparison, quote, image). Built by us on their *principles* (bounded-box
  fit discipline, asymmetric splits, CSS data-viz, micro-texture, exact token discipline).
  **Not copied** — clean IP + the honest "studied their approach, built my own system" story.
  Every exemplar constrains overflow **by construction** (bounded content box + content caps
  + min font size) so the layout structurally can't overflow even when the client floor
  can't fire.
- `prompt.ts` — the design-system guide, generated from tokens/themes (theme selection by
  context, token scale, anti-ugly rules, voice guide incl. no-em-dashes, image patterns,
  the shell contract). **Delivered as the `create_artifact` *result*** (progressive
  disclosure, like `system.load_integration`), not baked into the tool description or system
  prompt — so it's paid only when authoring and sits in the transcript, prompt-cached across
  the N `append_artifact_page` calls.

Authoring: the boss authors freehand page-`<style>` + body per page against the shell, on
the active chat tier (Haiku on Auto). For a multi-slide or ambiguous deck it first proposes a
**short outline in its conversational reply** (prompt-only soft-outline, no formal HIL) and
builds on the go-ahead. Authoring is **sequential** (`append_artifact_page` per page); no
parallel fan-out. Reuses the existing `pages` kind — **no new `deck` kind**.

**Client-verified floor** (new, v1):
- The render iframe becomes **scriptable** — `sandbox="allow-scripts"` (deliberately *not*
  `allow-same-origin`, so it stays origin-isolated from the host). Model HTML is sanitized
  down to inert markup before the harness is injected: strip `<script>`, event-handler
  attributes, `javascript:` URLs, active SVG/scriptable surfaces, external network loads, and
  any model-authored `postMessage` path. The injected harness is the **only** script and its
  reports carry a per-render nonce so the host ignores spoofed fit messages. It measures
  `scrollHeight/Width` against the logical 1280×720 (or 816×1056) box and `postMessage`s
  `{pageIndex, overflowPx, offendingSelector, nonce}` back to the host.
- On overflow, the client reports it to the server, which enqueues an **invisible bounded
  repair pass** (a background run, *not* a visible chat turn) that calls `update_artifact` on
  just the offending page with a narrow "over by Npx, tighten this element" brief, reusing
  the same scaffold. Re-render → re-measure → **≤2 retries**, then ship best-effort.
- The artifact stays **`generating`** until measurement confirms fit (or retries exhaust) —
  that makes "auto-repaired before it shows `complete`" honest. Measurement is opportunistic
  (needs a live browser rendering the artifact — ADR-0075 auto-opens the sidebar on create),
  so the by-construction exemplar discipline is the **backstop** when no browser reports.

**Vision critique/repair (deferred, flag-gated):** screenshot (server Chromium) → vision
model + theme spec + rubric (overflow / contrast / alignment / theme-consistency) →
auto-repair on fail. Rides in with the export Chromium; the biggest "exceed" lever, but a
fast-follow, not a v1 gate.

**Read-only export (download) — Phase 3:**
- **One engine: in-house headless Chromium** (Playwright/Puppeteer, library chosen at build).
  All PDF/PNG export renders the shared HTML shell → Chromium → PDF: `pages` (slides + pdf
  format) directly, `document` (markdown) via markdown → design-system HTML → Chromium.
- **In-house only.** Managed HTML→PDF SaaS and agentic-browser clouds (e.g. browser-use)
  rejected — the artifact carries the user's private content; keep it in Alfred's infra.
- **On-demand, no new required service.** Launch Chromium inside the existing server process
  (a BullMQ export job); no idle browser. Only if the memory spike threatens the co-hosted
  API/agent/triage/briefing workers do we isolate exports into a dedicated worker service —
  decided empirically at build time. The same Chromium serves the deferred vision-repair.
- **In-app viewing needs no browser** (already renders in the iframe); Chromium is only for
  the *download* export and vision-repair.

### Escape-hatch lane — editable-native Google Slides

The existing `artifact-native-mirror-v1.md` Option B: structured `DeckContent` →
server-built Google Slides `batchUpdate` (Slides is already writable). Triggered when the
user wants to edit in Slides. Template-bounded quality by design (its job is editability,
not pristine). A **genuinely separate authoring path** — *not* a shared IR with the flagship
(a quality-preserving HTML↔structure IR is a later epic; even Dimension didn't build one).
Shares tokens for visual consistency where feasible.

### Docs / sheets

- **Documents:** markdown artifact (styled via the design system's doc styles) + Chromium PDF
  (Phase 3); native Google Doc mirror deferred (markdown→Docs is the easiest native path if
  wanted).
- **Sheets:** table artifact + Google Sheets (already writable) for the editable path.

---

## Phases

**Phase 1 — design-system core (no new infra, biggest quality jump).**
`@alfred/artifacts-design` (tokens → shell + prompt + 1 house theme with ~3–6 layout
exemplars, all by-construction fit-safe); deliver the design system as the `create_artifact`
result; retrofit the renderer to wrap the shell (extend `PAGE_RESET`). Result: the *existing*
in-app artifacts become pristine, cached, and consistent — zero new services.

**Phase 2 — client-verified floor (no new infra).** Scriptable measuring iframe +
postMessage overflow channel + the invisible bounded repair pass (≤2 retries) + `generating`
lifecycle until fit-confirmed.

**Phase 3 — read-only export + vision-repair.** In-house on-demand Chromium (Playwright/
Puppeteer) for all PDF export against the shared shell; flag-gated vision-repair on the same
Chromium.

**Phase 4 — editable escape hatch.** Structured→Google Slides (folds in
`artifact-native-mirror-v1.md` Option B) + the guaranteed-artifact / honest-fallback prompt
rule.

**Phase 5 — breadth.** More themes + layout archetypes (toward Dimension's 8×17), sheets/docs
native mirrors, and (if long-form print quality is a felt gap) Typst for documents.

---

## Acceptance

- "Make me a 4-slide deck on X" → a pristine, on-theme, fit-checked artifact deck in the
  sidebar (one theme, no overflow), from the design system — not per-turn ad-hoc CSS, not two
  blank Google decks.
- Overflowing content is auto-repaired (client fit-check → invisible repair) before the deck
  shows `complete`.
- "I want to edit this in Google Slides" → a populated (not blank) editable deck via the
  structured lane.
- Markdown report → download → Chromium PDF against the shared shell (Phase 3).
- Design tokens live in one module; the shell + prompt are generated from it (no drift); the
  same shell wraps view and export.
- `pnpm check-types` green; `pnpm check:web-boundaries` respected (pure design package).

---

## Resolved decisions (grill 2026-07-01)

1. **Authoring altitude** → follow the picker (Haiku on Auto), no model gating; bet on the
   scaffold + client floor.
2. **Verified floor** → client-measured (scriptable iframe → postMessage → invisible bounded
   background repair, ≤2 retries; `generating` until fit); exemplars constrain-by-construction
   as the backstop.
3. **Vision-repair** → deferred to the export/Chromium phase, flag-gated (client can't
   screenshot a sandboxed iframe).
4. **Outline-HIL** → prompt-only soft-outline for multi-slide/ambiguous decks; sequential
   authoring; no formal HIL.
5. **Structured deck variant** → no; freehand-HTML-only flagship (reuse `pages`); escape-hatch
   keeps its own structured content as a separate lane.
6. **Shell delivery** → render-time injection (extend `PAGE_RESET`); token-generated base CSS
   + self-hosted subset fonts + inline SVG icons; one shell source for view + export; no CDN.
   Pages become shell-dependent (amends ADR-0075).
7. **Design-system prompt** → progressive disclosure via the `create_artifact` result; not the
   tool description / system prompt.
8. **Package boundary** → pure web-safe `@alfred/artifacts-design`; export drivers in the API
   module (not the design package, not a second package yet).
9. **Export browser** → in-house only (managed SaaS + browser-use rejected on privacy);
   on-demand Playwright/Puppeteer inside the existing worker process; split out only if memory
   demands.
10. **Render engine** → one engine, Chromium; Typst dropped from v1 (documented future option).
11. **ADR scope** → single ADR-0083; amends ADR-0075, reframes `artifact-native-mirror-v1.md`,
    supersedes ADR-0043's populate-on-create line.
12. **Cost** → v1 (Phases 1–2) adds no infra and no recurring cost; Chromium enters only at the
    deferred Phase 3, on-demand, no required new service.

---

## Recommend

**ADR-0083 — pristine artifacts via a design-system + client-verified floor** (freehand-HTML
flagship + structured-native escape hatch). Amends ADR-0075 (self-contained page →
shell-dependent, iframe gains `allow-scripts`); reframes `artifact-native-mirror-v1.md` as the
escape-hatch spec; supersedes the "populate-on-create" line in ADR-0043's plan.
