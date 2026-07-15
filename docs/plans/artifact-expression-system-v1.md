# Implementation plan — artifact expression system (motion / marks / diagrams under a governed dial, and the render-surface inflection)

**Status:** proposed (2026-07-15). Records **ADR-0086**. Extends ADR-0075 (artifact epic,
`decisions.md:4040`) and finally scopes the deferred **Phase 2b (verified floor)** + **Phase 4/5
(breadth)** of `pristine-artifacts-v1.md`. No code written yet; this is the structural design the
owner greenlit ("this direction looks good").

**v1.1 (2026-07-15):** tightened the three hard engineering parts — motion timing, motion safety,
and diagram feasibility — from "asserted" to "mechanised" (see the marked spots below).

**Builds on:** the shipped `@alfred/artifacts-design` (tokens → shell → archetypes/templates →
prompt, retroactive render-time reskin), the render-time dark mode (`project_artifact_dark_mode`),
the font-inlining precedent (`fonts.ts`), and the incremental-authoring shape (ADR-0085).

**Recon basis:** Dimension `../-dimension-ai-web` (`apps/ai-export`) — artifacts are rendered
**server-side in headless Chromium (Playwright)** with **full CDN access** (`cdn.tailwindcss.com`,
Font Awesome, 15+ Google Fonts, React UMD, Univer for sheets); `page.setContent(html)` →
`waitForLoadState("networkidle")` → wait for fonts → `page.screenshot()`. That render surface
already drives thumbnails/exports and is the exact substrate a vision-critique loop needs. Dimension
has **no automated visual QA loop** (human eyes → edit); the pristine-artifacts plan always intended
Alfred to *add the floor they lack*.

---

## The reframe (the actual lever)

The ask — "add animations / SVGs / draw objects, make presentations fancier **on demand**" — is a
symptom. The lever is recognizing that the shipped system already found the one pattern that works,
and **themes and archetypes are just two instances of it**:

> **The capability primitive.** Never let the model freehand raw CSS/SVG. Give it a *curated,
> named, token-derived vocabulary* that lives in the **retroactive shell**, and only *name* it in
> the lean, cache-stable prompt. `art-card` looks good every time; a model hand-rolling a résumé
> looked like garbage. That delta is the whole thesis.

"Fancy on demand" is therefore **more instances of the same pattern along axes not yet built** —
motion, marks/illustration, diagrams, richer charts — **held under one governance dial** so
richness never regresses the hard-won Apple-restraint. It is not a new mechanism; it is the existing
mechanism, extended.

---

## The constraint envelope (verified in code — this shapes every option)

Any richness must survive these or it cannot ship:

1. **`sandbox=""` opaque origin** (`artifact-page-frame.tsx:76`) → no scripts, no CDN, no external
   fetch. Pure CSS + **inline SVG** only.
2. **iframe is `pointer-events: none`** → zero hover/click/scroll. Motion can only be
   **autoplay-on-mount** keyframes, never interaction-driven.
3. **Pages render as a vertical stack; each iframe mounts once** (`artifact-viewer.tsx:216`) — and
   today *all* iframes mount on load, so an on-mount entrance would fire on every page at once and
   finish long before you scroll to page N. **Resolved by viewport-gated mount:** the parent app DOM
   (where JS *is* allowed — the iframe can't see the parent's scroll, and `animation-timeline: view()`
   inside it is inert because the page doc itself doesn't scroll) lazy-mounts each page's iframe on
   first intersection (the `landing/fade-in-on-scroll.tsx` `IntersectionObserver` pattern already in
   the app), and keeps it mounted. So mount = reveal = the entrance fires exactly as the page scrolls
   in, once. This is also the present-mode seam (advance = mount next) and a paint-cost win, at no
   cost to the sealed sandbox.
4. **Print/export reuses the same shell** off-screen (`buildArtifactPrintDocument`). There is
   **no `@media print` animation guard today** — a mid-flight animation would print half-faded.
   **Resolved by one central guard, not one-per-primitive:** a single shell-level `@media print` /
   `prefers-reduced-motion: reduce` rule forces `animation: none` to the element's *resting* state,
   and every shell keyframe is authored so resting state = the final visible state — so the one guard
   covers every motion primitive, present and future, and a new primitive cannot forget its guard.
5. **Retroactive shell** = the high-leverage seam. Editing `tokens.ts`/`shell.ts` reskins every
   existing artifact, zero migration, zero stored bytes.
6. **Lean cache-stable prompt** = capabilities must be *named*, never *dumped* (recurring token
   cost per turn).

**The consequence that makes this safe — mechanised in two complementary parts, not asserted:**
(1) the shell owns *one* central `@media print` / `prefers-reduced-motion` guard (constraint 4), so
every shell motion class is guarded by construction. (2) The authoring **validation layer** — today
PDF-only (`validation.ts`, enforced at `write.ts:153`) — is extended to reject authored `@keyframes`
and `animation:` declarations in `<style>`/inline `style=` for *both* slides and PDF, using the same
`authoredStyleSources` extractor it already has. Part 2 is what closes the real hole: without it a
model could set an `opacity: 0` base state that the central print guard would then freeze *invisible*.
With both, authored HTML literally cannot animate; only the guarded shell classes can. The slide
check is **motion-only** — it does *not* impose the PDF font/root rules, so slides keep their
inline-geometry freedom (they are unvalidated today).

---

## The two layers

The work splits into two orthogonal layers. Keeping them separate is what lets Layer 1 ship now and
Layer 2 land later with **no rework**.

- **Layer 1 — expression vocabulary** (within today's sealed sandbox). The capability matrix below.
  Retroactive, cache-cheap, safe by construction, no contract change (except theme packs).
- **Layer 2 — the render surface** (the infra inflection the owner is pointing at). A headless
  render service that unblocks the ceiling: a QA floor (fit-check + vision-repair) and, optionally,
  CDN assets.

The design-system vocabulary is the **contract** the vision-repair rubric critiques *against* and
repairs *toward* ("use a diagram archetype, not hand-rolled boxes"); the render surface is the
**substrate**. Orthogonal by design.

---

## Layer 1 — the capability matrix

| Axis | Primitive (where it lives) | Why it's reliable under the envelope | Leverage / cost |
|---|---|---|---|
| **A. Motion** *(new)* | `@keyframes` + named classes in `shell.ts`: `art-rise` (fade+lift), `art-stagger` (children reveal via `nth-child` delays), `art-draw` (SVG stroke draw-on via `stroke-dashoffset`), `art-drift` (slow aurora float), `art-sheen` (bar shimmer once). Each keyframe animates **from** a hidden state **to** the element's *resting* state (resting = final visible), guarded by the **single central `@media print` / `prefers-reduced-motion` rule** (constraint 4). Keyframes stay within the page box (no edge slide-in — `.art-page` clips). | Pure CSS; fires **on reveal**, not on load, once viewport-gated mount lands (constraint 3) — so each entrance is actually seen as the page scrolls in, not spent before you arrive. Forward-compatible with present-mode (mount = slide-advance = Keynote builds), no rework. | Retroactive, ~zero bytes, ~zero prompt cost. One prerequisite: the viewer mount-gating (an app-DOM change, not shell). |
| **B. Marks / illustration** *(new)* | One inline **SVG sprite** in the shell `<defs>` (~16–24 workhorse glyphs: check, arrow, spark, bolt, shield, clock, trend…), referenced by `<use href="#art-i-check">`, `currentColor`-driven. Plus CSS texture fills: `art-texture-grid`, `art-texture-dots`, `art-mesh`. | Model picks an **id from a list** — never draws a path. Internal `<use>` works in the opaque origin; `currentColor` themes for free (light/dark/accent). | Retroactive; one-time bytes per doc; prompt cost = one line naming the set. |
| **C. Diagrams** *(new — highest value for decks)* | A new *category* of archetype in `archetypes.ts`, admitted under a hard rule. **The rule that makes "model fills text, not geometry" true:** an archetype ships only if its layout is expressible as **flex/grid + a per-item scalar** — then the container CSS draws the connectors and the model supplies a semantic container + children, isomorphic to the shipping `art-list` (`<ol class="art-process"><li>…`). That covers `process` (steps + `::after` arrows), `timeline` (running line via a container pseudo-element), `comparison` (grid + sprite check/cross), `quadrant` (2×2 grid), `funnel` (rows sized by one inline width each, exactly like `art-bar-fill`). **`node-graph` fails the rule** — free 2D placement + edge routing has no container-driven pure-CSS form under the sandbox — so it ships *only* as a small set of **fixed-layout templates** (hub-of-3, hub-of-4, chain, cycle) with pre-drawn SVG edges where the model fills node labels, or is dropped from v1. | The reliability bet is evidence-based, not hopeful: a diagram that mirrors the *shipping* `art-list` container+children shape is as reliable as `art-list`. | Fixtures + one prompt line each; the container convention is self-describing, so it stays cache-cheap (no exemplar dumped into the prompt). |
| **D. Charts beyond bars** *(extend)* | SVG donut/ring (`stroke-dasharray`, one number), sparkline/area (polyline), progress ring — alongside the existing CSS bar. | Parameterized by 1–2 numbers → reliable. Run through the `dataviz` skill for categorical-hue discipline (hue tokens already exist). | Shell + archetype; cheap. |
| **E. Theme packs** *(breadth — the owner's own analogy)* | Promote `theme.ts` from one house theme to a small set of **packs**: each = a token override (accent, neutral temperature, radius, display-font personality, default motion intensity) + archetype affinity. E.g. *Editorial* (today), *Bold* (marketing), *Technical* (mono-tinged, no aurora), *Warm*. | Same token-swap mechanism dark mode already proved. | **Heaviest: not retroactive.** "On demand per artifact" needs a `theme`/`variant` field on the artifact contract + DB migration + tool param + prompt. Same shape as the deferred authored-dark-theme. |

### The governance spine — the thing that makes it "on demand," not slop

The risk is obvious: "fancy" undoes the restraint. The system *already* has an implicit dial — the
aurora rule ("skip it for serious/technical, reserve it for celebratory/marketing"). The structural
move is to make that dial **explicit and apply it across the whole matrix**:

> An **expression level** — `still → lively → showcase` — that scales motion, texture, decor, and
> accent intensity together. Defaults to restrained. Inferred from the deck's purpose (a financial
> review is `still`; a launch deck is `showcase`) and/or set explicitly as a tool param.

This generalizes the one rule already trusted into a single knob, so "on demand" is a *bounded
control* the model reasons about once, not a license to freelance on every page.

### Render targets — one grammar, three realizations

"Make documents fancy too" is not a fourth axis; it is the recognition that **the capability
vocabulary is render-target-agnostic**. There is one design grammar (the primitives, the tokens, the
dial); it is *realized* three ways, each inside its own constraint profile — and in one case the
profile is MORE capable, not less:

| Target | Kind / format | Runtime | Can do | Cannot do |
|---|---|---|---|---|
| **Slides** | `pages` / `slides` | sandboxed iframe | pure CSS motion, inline SVG | JS, interactivity (`pointer-events:none`) |
| **PDF doc** | `pages` / `pdf` | sandboxed iframe, print-bound | marks, diagrams, charts (static) | motion (print flattens it) |
| **Prose doc** | `document` | **native React in app DOM — not sandboxed** | **real** motion/interactivity, real SVG chart components, selectable text | freehand layout (markdown structure only) |

1. **The PDF-document medium is already on the shell** — extending marks (B) + diagrams (C) +
   charts (D) into the `art-doc-*` layer and `documentTemplates` is a small Layer-1 increment (teach
   `validation.ts` to accept `<use>`/svg diagram markup; the dial pins `pdf` to motion-off).

2. **The prose `document` (markdown) has the OPPOSITE profile and today has nothing.** It renders
   through `markdown-renderer/` — a thin ReactMarkdown wrapper with a component registry
   (`elements.tsx`, documented "one-file, one-entry" seam) plus an `extraRemarkPlugins` /
   `extraComponents` API the **briefing already uses** to map a custom `[[kind:id]]` syntax to
   entity-chip components. So the idiomatic move is a **remark plugin + component registry**: map a
   small directive/fenced vocabulary (`:::callout`, `:::stat`, ` ```chart `, ` ```diagram `,
   ` ```timeline `) to design-system React components sharing the same tokens/hues (the
   `@alfred/artifacts-design` token module is pure web-safe data — importable here). Because
   ReactMarkdown enables **no raw HTML** (no `rehype-raw`), the model cannot inject markup; it only
   supplies *data* to *our* trusted components (validated at the boundary with a zod schema per the
   web data-boundary rule). That is a cleaner security story than the iframe, and — being native
   React — it unlocks *real* motion/interactivity the sandboxed targets can't have.

**Charts and diagrams are the most portable axis** (equal value across all three targets) → the
highest-leverage cross-cutting investment. Motion is target-specific: rich in prose docs, CSS-only in
slides, off in PDF.

**Rejected:** converging the prose `document` onto the iframe shell (markdown → art-doc HTML →
iframe). It would unify renderers but forfeit native React's wins for long-form reading (text
selection, accessibility, the existing gfm/katex/entity-chip stack, streaming) and gain nothing
markdown structure can express — the `document` kind exists precisely for in-app prose, where native
rendering is correct.

---

## Layer 2 — the render surface (the inflection)

Both of the owner's forward signals — an **asset/font CDN** and **Playwright vision correction** —
and the deferred pristine-artifacts **Phase 2b/3b** all pivot on **one missing capability: a trusted
headless-Chromium render service** (Dimension's `ai-export` shape; a Browserless sidecar on
Railway). "No headless Chromium ships today (Elysia on Railway)" is the sentence that deferred all of
it. Adding it unlocks three things, in ascending cost/risk:

1. **Deterministic fit-check** *(cheapest, do first within Layer 2)*. Headless-measure each finalized
   page against its bounded box; on overflow/void, feed the offending element + delta back →
   bounded auto-`update_artifact` (≤2 retries). Kills freehand's #1 failure mode, which the shell
   only *instructs* against today. No vision model.

2. **Vision critique / repair** *(the differentiator)*. Screenshot → vision model + the theme/archetype
   spec + a rubric (overflow / contrast / alignment / theme-consistency / **is this a diagram
   archetype or hand-rolled boxes** / **is the expression level appropriate to the subject**) →
   targeted auto-repair on fail. This is Phase 2b of the original plan, and it is **Alfred's
   deliberate edge over Dimension** ("they rely on human eyes; we add the floor they lack"). It is
   exactly what makes Layer 1's richer, more failure-prone output (complex diagrams, animations,
   many-series charts) *safe*, because those are the things that break silently.

   **Key decoupling:** this loop renders the **same inline shell** the client already renders, at
   **generation time, server-side**. It needs **no CDN** and does **not** touch the live
   `sandbox=""` display path. Generation-time render (QA) ≠ view-time render (display).

3. **Asset CDN + richer display** *(heaviest, most security-laden — its own gated decision)*. Letting
   artifacts pull fonts / icon libraries (Font Awesome) / textures from a CDN is what Dimension does,
   and it mainly buys **font + icon breadth** (i.e. theme-pack personality via type). But it
   **reverses a deliberate ADR-0075 posture** (opaque origin, inline-everything, no supply chain,
   offline). It requires either relaxing the client-iframe CSP to an asset allowlist (a real security
   decision) or moving display server-side too, and it adds a network failure mode. Most of the
   *visible* richness (Axes A–D) needs none of it — the sprite covers icons, a couple of inlined
   display faces cover font personality. **Treat the CDN as an independent axis, gated on a clear
   need for arbitrary type/icon breadth, not bundled with the QA floor.**

---

## Phasing & leverage map

| Phase | Scope | Contract change? | Retroactive? | Infra? |
|---|---|---|---|---|
| **1a** | Viewport-gated mount (viewer) + motion (A) + central guard | no | yes† | client only |
| **1b** | SVG sprite + textures (B) | no | yes | no |
| **1c** | Diagram archetypes (C) + chart primitives (D) | no | partial* | no |
| **1d** | Explicit expression dial (governance) | tool param (light) | n/a | no |
| **2** | Theme packs (E) | yes (field + migration) | no | no |
| **3a** | Headless render service + deterministic fit-check | no | n/a | **Railway service** |
| **3b** | Vision critique/repair loop | no | n/a | uses 3a |
| **3c** | Asset CDN + relaxed-CSP display *(gated, optional)* | no | n/a | CDN + CSP |

\* new pages use the new archetypes; existing pages are unaffected (which is fine).
† shell motion is retroactive; the on-reveal *timing* needs the one-time viewer mount-gating change
(app-DOM, no service).

Phases **1b–1c ship across all three render targets** (slides CSS/SVG, the `art-doc-*` layer for
PDF, and the markdown component-registry for prose docs — see *Render targets* above); Axis **A
motion is slides + prose only** (PDF is motion-off).

**Recommended first move:** Phase 1a–1c — motion, sprite, diagram archetypes (+ charts).
Shell-resident except one client change (the viewer mount-gating), retroactive, cache-cheap, safe by
construction (central guard + validation ban), no migration, no service. Maximum visible "fancy" for
near-zero infra and zero contract risk. Then the expression dial (1d) to govern it. Theme
packs (2) and the render surface (3) are separate projects, sequenced after the vocabulary proves
out.

---

## Decisions baked in

- **Vocabulary-first, not render-surface-first.** The QA loop needs a vocabulary to critique against
  and repair *toward*; repair means "use a diagram archetype," not "emit better freehand SVG." So
  Layer 1 precedes Layer 2 even though Layer 2 is the more exciting infra.
- **The QA loop does not require touching the sandbox.** Generation-time server render is separate
  from view-time client render. This is what lets us add Alfred's differentiator without reversing
  ADR-0075's security posture.
- **The CDN is the last, gated axis** — not because it's hard, but because it's a deliberate posture
  reversal that most of the richness does not need.
- **Motion safety is enforced, not instructed** — one central shell guard (print +
  reduced-motion) covers all motion primitives, and the validation layer (extended to slides,
  motion-only) rejects authored `animation`/`@keyframes`. Together these make "the model cannot
  author output that breaks print" literally true rather than a prompt hope.
- **Diagrams obey the container-driven rule** — flex/grid + a per-item scalar only; free-2D layouts
  (node-graph) ship as fixed templates or not at all. This is what keeps diagrams cache-cheap and as
  reliable as the shipping `art-list`.
- **Motion timing is a viewer concern, not a shell one** — the on-mount keyframe is retroactive via
  the shell, but it only reads as an *on-reveal* build once the viewer lazy-mounts each iframe on
  intersection. Phase 1a therefore carries one small app-DOM change alongside the shell work.

## Open forks

- **Prose `document` (markdown) construct set.** The realization is designed in *Render targets*
  above (remark plugin + component registry, native React); the exact directive/fenced vocabulary
  (`:::callout`, ` ```chart `, …) and how the model is taught it (a prompt block parallel to the
  `art-*` one) is unpinned — pin it when Phase 1c lands charts/diagrams so one primitive set serves
  both the iframe and markdown targets.
- **Expression dial: inferred vs explicit.** Recommend *both* — model infers from purpose, tool param
  overrides. Pin during 1d.
- **Present mode.** A future click-to-advance slide mode makes the motion primitives pay off far more
  (mount = build). Worth noting as a pull-forward reason for Axis A.

## Quality lens

Hold motion work to `apple-design` / `emil-design-eng` (physical, interruptible, restrained), charts
to `dataviz` (categorical-hue discipline, light+dark), and run `improve-animations` / `polish` before
shipping each phase. The bar stays where the dark-mode + overhaul threads set it.
