# Dimension.dev artifact HTML corpus

Raw `srcdoc` HTML extracted from the per-page `<iframe>` mounts that render Dimension's generated artifacts (PDFs, presentations, docs, sheets).

This is the **document engine** — the most under-documented part of Dimension and the biggest roadmap gap for Alfred. The chat archive shows what these artifacts look like in the UI; this folder shows the raw HTML the LLM emits.

Captured 2026-05-17, ahead of the May 20 shutdown.

## What we have

- `sycamore-pdf/` — the 6-page Research Briefing PDF Yash generated about Sycamore Labs. 5 distinct page templates show up across the 6 pages (page 2 and 3 share a template).

Still uncaptured (would close the corpus):
- A **presentation** artifact (16:9 slides instead of US Letter portrait)
- A **document** artifact (longform prose, less chrome)
- A **spreadsheet** artifact
- A **second design system** — the Sycamore PDF uses an electric-lime-on-forest-green palette, but the LLM picks colors per artifact. A different prompt would surface a different palette.

## Architectural takeaways

### 1. Pure inline-style HTML, no class system

Every element is styled via `style="..."` attributes. No `<style>` blocks beyond the page-level reset and Google Fonts import. This is what makes it tractable for an LLM:

- Each element is self-contained — no cross-references to a class system the model must remember
- The model can copy/adapt one element to make another (e.g. duplicate a metric card and change the label/value) without rebuilding context
- No risk of dangling class references or unused styles

Trade-off: the HTML is verbose (~7KB per page) and not optimised for download. But these are one-shot artifacts, not pages — verbosity is fine.

### 2. Fixed page dimensions

```html
<meta name="viewport" content="width=816, height=1056">
<style>
  body { width: 816px; height: 1056px; overflow: hidden; }
  @page { size: 8.5in 11in; margin: 0; }
</style>
```

816×1056 px = 8.5×11 inches at 96 DPI. Standard US Letter portrait. The `overflow: hidden` is critical — if content runs past the page boundary, it's clipped (the model is responsible for fitting content per page, not the renderer).

### 3. The font palette is enormous

Every page imports **18 Google Fonts** + Material Symbols:

> Antonio, Bodoni Moda, Crimson Pro, DM Sans, Inter, Libre Baskerville, Lora, Manrope, Merriweather, Nunito, Outfit, Playfair Display, Plus Jakarta Sans, Poppins, Roboto, Source Sans 3, Source Serif 4, Space Grotesk

So the LLM has a curated typography library to pick from per artifact. For the Sycamore PDF it picked `Antonio` (compressed condensed sans for display) + `Inter` (body) — a confident, magazine-y pairing. A different brief could result in `Playfair Display + Source Serif 4` for a more formal/editorial feel.

**Pattern for Alfred**: ship ~15–20 high-quality Google Fonts in the artifact template by default, and instruct the model to pick a paired display/body combo per artifact based on the brief's tone.

### 4. The renderer signals readiness via postMessage

Every page ends with:

```js
document.fonts.ready.then(() =>
  window.parent.postMessage({ type: 'pdf-page-ready' }, '*')
);
setTimeout(() => window.parent.postMessage({ type: 'pdf-page-ready' }, '*'), 2000);
```

This is how the parent chat UI knows a page is "done streaming." The 2s timeout is the fallback. **This is what removes the iframe's `busy` a11y flag** mentioned in [`../NOTES.md`](../NOTES.md) — it isn't the iframe `load` event, it's a custom postMessage waiting on `document.fonts.ready`.

Alfred can lift this verbatim.

### 5. Page-level "template" patterns

Inspecting the 6 captured pages, 5 reusable templates emerge:

| Template | Captured in | Use |
| --- | --- | --- |
| **Cover** | `page-1-cover.html` | Title page. Eyebrow badge, big h1, accent bar, 3-column metadata strip, footer line |
| **Person solo** | `page-2-person-solo.html` | Single entity feature. 38/62 split: side-card with timeline / right-column prose. Pullquote callout at bottom |
| **Person solo + recognitions** | `page-3-…recognitions.html` | Same as above but side-card stacks two sections (Career + Recognitions) |
| **Person duo** | `page-4-person-duo.html` | Two compact entity blocks per page, stacked vertically with a divider line. Each is 65/35 (prose + connection-angle card) |
| **Person + grid** | `page-5-…role-grid.html` | Continuation pattern: one person at top, then a 2×N grid of mini-entities (jobs) below |
| **Strategy / mixed list** | `page-6-strategy.html` | Three-section page: prose intro, 3 highlight cards, checklist with arrows, pullquote callout |

The model's job is **to pick a template per page based on what content needs to fit there**, then generate the HTML inline. There's no template selector in the LLM's tool inputs — it just emits the right shape.

### 6. The repeating chrome

Every non-cover page has:

- **44px top header bar** with eyebrow text left/right (e.g. `SYCAMORE LABS` / `KEY PEOPLE`)
- **40px bottom footer bar** with breadcrumb left + page counter right (e.g. `SYCAMORE LABS · RESEARCH BRIEFING` / `02 / 06`)
- Both bars use `border-(top|bottom): 1px solid rgba(204,255,0,0.08)` — barely-there accent dividers
- Eyebrow text: `Antonio` 11px uppercase tracked, `rgba(255,255,255,0.35)` color

The cover page replaces the header with a 3px accent-color top bar instead.

### 7. The design-token vocabulary used in this artifact

Pulled from across all 6 pages:

| Token | Value | Use |
| --- | --- | --- |
| Background | `#0A1A14` | Page bg (deep forest) |
| Accent | `#CCFF00` | Lime — used for emphasis, dividers, badge borders, callout left-border |
| Heading | `#FFFFFF` | All h1/h2 |
| Body | `rgba(255,255,255,0.5)` | Main prose |
| De-emphasized | `rgba(255,255,255,0.4)` | Captions, role descriptions |
| Hint | `rgba(255,255,255,0.35)` | Eyebrows, labels |
| Footer text | `rgba(255,255,255,0.25)` | Page counter, footer breadcrumb |
| Surface low | `rgba(255,255,255,0.02)` | Card backgrounds |
| Surface border | `rgba(255,255,255,0.06)` | Card borders |
| Accent low | `rgba(204,255,0,0.04)` | Callout/quote background |
| Accent border | `rgba(204,255,0,0.08)` | Header/footer dividers |
| Display font | `Antonio` | Headings, eyebrows, labels — uppercase + tracked |
| Body font | `Inter` | Prose, body, descriptions |

### 8. Reusable visual primitives

These appear across multiple pages:

```html
<!-- 1. Eyebrow badge (lime border, lime text, uppercase tracked) -->
<div style="display: inline-flex; align-items: center; padding: 5px 14px;
            border: 1px solid rgba(204,255,0,0.2); margin-bottom: 16px;">
  <span style="font-family: 'Antonio'; font-size: 11px; text-transform: uppercase;
               letter-spacing: 0.25em; color: #CCFF00;">01 · FOUNDER &amp; CEO</span>
</div>

<!-- 2. 48×3 lime accent rule (under big headings) -->
<div style="width: 48px; height: 3px; background: #CCFF00; margin-bottom: 24px;"></div>

<!-- 3. Metadata card (rounded, faint border, tiny eyebrow + value + caption) -->
<div style="padding: 20px; border: 1px solid rgba(255,255,255,0.06);
            background: rgba(255,255,255,0.02); border-radius: 4px;">
  <div style="font-family: 'Antonio'; font-size: 10px; ...">FUNDING</div>
  <div style="font-family: 'Antonio'; font-size: 20px; font-weight: 700;">$65M</div>
  <div style="font-size: 12px; color: rgba(255,255,255,0.4);">Coatue + Lightspeed</div>
</div>

<!-- 4. Lime-bordered pullquote callout -->
<div style="padding: 18px 22px; border-left: 3px solid #CCFF00;
            background: rgba(204,255,0,0.04); border-radius: 0 4px 4px 0;">
  <strong style="color: #CCFF00;">How to connect:</strong> …
</div>

<!-- 5. Bullet row with lime square (used in lists, role grids, checklists) -->
<div style="display: flex; align-items: flex-start; gap: 10px; padding: 12px;
            border: 1px solid rgba(255,255,255,0.06);
            background: rgba(255,255,255,0.02); border-radius: 4px;">
  <div style="width: 8px; height: 8px; background: #CCFF00; border-radius: 2px;
              margin-top: 3px; flex-shrink: 0;"></div>
  <div>…label + caption…</div>
</div>

<!-- 6. 1px lime divider (between sections) -->
<div style="height: 1px; background: rgba(204,255,0,0.08); margin: 18px 0;"></div>
```

These are the LLM's reusable building blocks. The way Alfred should think about a document-engine LLM prompt: **list these primitives in the system prompt** and let the model assemble pages out of them, with full design freedom to swap fonts / palette / spacing per artifact.

## How Alfred should adapt this

A document engine for Alfred could be the same shape:

1. **A renderer.** Per-page `<iframe srcdoc>` mounts, fixed page dimensions, `postMessage`-based readiness handshake. Iframe sandbox flags (which Dimension doesn't set — worth considering for safety with arbitrary LLM-emitted HTML).
2. **A system prompt** that gives the LLM:
   - The page dimensions and the renderer contract (must emit valid HTML, must close all tags, must end with the postMessage script)
   - The font palette (the 18 Google Fonts)
   - The visual primitives (the 6 above + maybe a couple more)
   - The brief (what to put on the page)
3. **A page-streaming protocol.** Each page is its own LLM call (or its own structured-output chunk), so they can stream into the artifact panel one-at-a-time. Per [`../chat-anatomy.md`](../chat-anatomy.md), the chat UI shows "Creating Cover Page page..." → "Created Cover Page page." per resolved page.
4. **A per-artifact design picker.** Either the LLM picks the palette/typography itself from a small set of options (e.g. 6 prebuilt design systems: editorial-warm, tech-cool, formal-corporate, …), or there's a quick prompt before the document run asking "what tone?"

The size of this is real — comfortable production version is probably a multi-week project — but the **template-and-primitives approach** keeps the LLM's job small and tractable. It doesn't have to invent design; it has to assemble.
