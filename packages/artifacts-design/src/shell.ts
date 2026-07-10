import type { ArtifactFormat } from "@alfred/contracts";
import { cssVariables, font, pageGeometry, spacing, type } from "./tokens";

/**
 * The render-time house shell for artifact pages (pristine-artifacts Phase 1).
 *
 * Model-authored pages are body-level HTML (see `ARTIFACT_DESIGN_PROMPT`); this
 * wraps that body in a complete, self-contained `<!doctype html>` document that
 * carries the design tokens, a reset, and a compact utility / primitive class
 * layer. Applied at render time by `ArtifactPageFrame` rather than baked into
 * the stored content, so it is retroactive (old rows re-skin on next paint) and
 * needs no re-store — mirroring the seam the old inline `PAGE_RESET` occupied,
 * which this subsumes.
 *
 * Hard constraint that shapes the design: the renderer's iframe keeps an
 * opaque-origin sandbox and does not permit scripts — so NO Tailwind CDN, NO
 * Font Awesome JS, NO runtime framework. Everything here is pure CSS. The shell
 * deliberately does not declare the app's own `/fonts/*.woff2`; the preview's
 * opaque-origin sandbox cannot consistently load those fonts, so export uses
 * the same system-sans fallback contract for visual parity.
 */

/**
 * Box-sizing + overflow reset. Leads the stylesheet so the page's own later
 * rules still win where they set the same property. Folds padding into the
 * fixed page box (`border-box`) and clips — never scrolls — any residual
 * overflow, since the iframe is `pointer-events-none` and a scrollbar there is
 * just a dead gutter. This is the old `PAGE_RESET`, absorbed into the shell.
 */
const RESET = `
*, *::before, *::after {
  box-sizing: border-box;
  /* Force backgrounds/gradients (aurora, badges, bars, accent marks, surfaces)
   * to render when the browser prints to PDF. Without this the UA default of
   * economy strips background colors/images and flattens colored pages to white
   * in the export (and in the print dialog when "Background graphics" is off). */
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
html, body { margin: 0; padding: 0; }
img, svg, canvas { display: block; max-width: 100%; }
p, h1, h2, h3, h4, h5, h6, ul, ol, figure, blockquote { margin: 0; }
ul, ol { padding: 0; list-style-position: inside; }`;

/** `:root { --art-*: … }` from the token source of truth. */
function rootVariables(): string {
  const decls = cssVariables()
    .map((token) => `  --${token.name}: ${token.value};`)
    .join("\n");
  return `:root {\n${decls}\n}`;
}

/**
 * Base page + a compact primitive/utility vocabulary. Kept deliberately small
 * (layout helpers, a type ramp, and a handful of surface/badge/rule/stat/chart
 * primitives) so the authoring model has a stable, named grammar to compose
 * without re-inventing CSS per page — the lever that makes freehand output
 * consistent. Everything is class-based; authors may still add their own inline
 * `<style>` for a specific page.
 */
function baseStyles(): string {
  return `
html, body { width: 100%; height: 100%; }

body {
  font-family: ${font.stack};
  font-feature-settings: "cv11", "ss01", "ss03";
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  color: var(--art-ink);
  background: var(--art-surface);
  letter-spacing: ${type.tracking};
  font-size: ${type.body};
  line-height: ${type.lineBody};
  overflow: hidden;
}

/* The page canvas: the fixed logical box authors compose inside. Locked to the
 * format geometry so content is authored against a stable size; the shell owns
 * these dimensions — pages must not set their own. */
.art-page {
  position: relative;
  width: 100%;
  height: 100%;
  padding: ${spacing.pageInset};
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* Layout helpers */
.art-stack { display: flex; flex-direction: column; gap: ${spacing.md}; }
.art-row { display: flex; flex-direction: row; gap: ${spacing.md}; align-items: center; }
.art-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: ${spacing.lg}; }
.art-split { display: grid; grid-template-columns: 1.4fr 1fr; gap: ${spacing.xl}; align-items: center; }
.art-fill { flex: 1 1 auto; min-height: 0; }
.art-grow { flex: 1 1 0; min-width: 0; }
.art-center { display: flex; flex-direction: column; justify-content: center; height: 100%; }
.art-between { justify-content: space-between; }
.art-end { justify-content: flex-end; }
.art-wrap { flex-wrap: wrap; }

/* Type ramp */
.art-display { font-size: ${type.display}; font-weight: 700; line-height: ${type.lineTight}; letter-spacing: -0.03em; }
.art-title { font-size: ${type.title}; font-weight: 700; line-height: ${type.lineTight}; letter-spacing: -0.025em; }
.art-headline { font-size: ${type.headline}; font-weight: 650; line-height: ${type.lineSnug}; letter-spacing: -0.02em; }
.art-subhead { font-size: ${type.subhead}; font-weight: 550; line-height: ${type.lineSnug}; }
.art-body { font-size: ${type.body}; font-weight: 450; line-height: ${type.lineBody}; }
.art-caption { font-size: ${type.caption}; font-weight: 450; line-height: ${type.lineSnug}; color: var(--art-fg-muted); }
.art-eyebrow {
  font-size: ${type.eyebrow};
  font-weight: 650;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--art-accent);
}

/* Color helpers */
.art-ink { color: var(--art-ink); }
.art-muted { color: var(--art-fg-muted); }
.art-subtle { color: var(--art-fg-subtle); }
.art-accent-text { color: var(--art-accent); }

/* Surfaces + primitives */
.art-card {
  background: var(--art-surface-raised);
  border-radius: var(--art-radius-lg);
  box-shadow: var(--art-shadow);
  padding: ${spacing.lg};
}
.art-panel {
  background: var(--art-surface-sunken);
  border-radius: var(--art-radius-md);
  padding: ${spacing.md};
}
.art-badge {
  display: inline-flex;
  align-items: center;
  gap: ${spacing.xs};
  padding: 6px 14px;
  border-radius: var(--art-radius-sm);
  background: var(--art-accent-soft);
  color: var(--art-accent-to);
  font-size: ${type.eyebrow};
  font-weight: 650;
  letter-spacing: 0.02em;
}
.art-rule { height: 1px; width: 100%; background: var(--art-border); border: 0; }
.art-accent-mark { width: 48px; height: 5px; border-radius: var(--art-radius-sm); background: linear-gradient(90deg, var(--art-accent-from), var(--art-accent-to)); }
.art-dot { width: 10px; height: 10px; border-radius: 9999px; background: var(--art-accent); flex: 0 0 auto; }

/* Stat block */
.art-stat-value { font-size: ${type.display}; font-weight: 700; line-height: 1; letter-spacing: -0.03em; color: var(--art-ink); }
.art-stat-label { font-size: ${type.caption}; color: var(--art-fg-muted); margin-top: ${spacing.xs}; }

/* CSS bar chart (no JS): a track + an accent-filled bar sized inline via width. */
.art-bar-track { width: 100%; height: 14px; border-radius: 9999px; background: var(--art-surface-deep); overflow: hidden; }
.art-bar-fill { height: 100%; border-radius: 9999px; background: linear-gradient(90deg, var(--art-accent-from), var(--art-accent-to)); }

/* Bulleted list styled with accent markers */
.art-list { display: flex; flex-direction: column; gap: ${spacing.sm}; list-style: none; }
.art-list li { display: flex; align-items: flex-start; gap: ${spacing.sm}; }
.art-list li::before { content: ""; margin-top: 10px; width: 8px; height: 8px; border-radius: 9999px; background: var(--art-accent); flex: 0 0 auto; }

/* Inline code: a quiet mono token that sits inside body copy. */
code {
  font-family: ${font.mono};
  font-size: 0.9em;
  background: var(--art-surface-sunken);
  padding: 2px 6px;
  border-radius: var(--art-radius-sm);
}

/* Code block: the house primitive for multi-line code. Wraps long lines (no
 * horizontal scroll under sandbox) and clips overflow so a too-tall block can
 * never push the page — authors keep blocks short instead. */
.art-code, pre {
  font-family: ${font.mono};
  font-size: 13px;
  line-height: 1.55;
  color: var(--art-ink);
  background: var(--art-surface-sunken);
  border-radius: var(--art-radius-md);
  padding: ${spacing.md};
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  overflow: hidden;
  tab-size: 2;
}
/* A <code> inside a block inherits the block's type; no double background. */
.art-code code, pre code { font-family: inherit; font-size: inherit; background: none; padding: 0; border-radius: 0; }

/* ── Document layer (art-doc-*) ──────────────────────────────────────────────
 * The vocabulary for the pdf medium: resumes, one-pagers, reports. Denser than
 * the slide type ramp (uses the --art-doc-* scale) but on the SAME palette
 * tokens, so a document reads on-brand without the model hand-rolling an
 * off-token grey/tiny type soup. Wrap page content in .art-doc; the container
 * fills the page height so a document can distribute vertically instead of
 * crowding the top. */
.art-doc {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  font-size: var(--art-doc-body);
  line-height: var(--art-doc-line-body);
  letter-spacing: -0.01em;
  color: var(--art-ink);
  overflow-wrap: anywhere;
}
.art-doc a { color: var(--art-accent-to); text-decoration: none; }

/* Header: name/role on the left, a contact stack on the right. */
.art-doc-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
.art-doc-header > :first-child { min-width: 0; }
.art-doc-name { font-size: var(--art-doc-name); font-weight: 700; line-height: 1.04; letter-spacing: -0.035em; }
.art-doc-role { font-size: var(--art-doc-role); color: var(--art-fg-muted); margin-top: 4px; }
.art-doc-contact { max-width: 42%; text-align: right; font-size: var(--art-doc-meta); line-height: 1.7; color: var(--art-fg-muted); flex: 0 1 auto; overflow-wrap: anywhere; }

/* The document's single brand moment: a thin accent rule under the header
 * lockup. At most one per page — the restraint is what keeps a document
 * reading professional rather than like a brochure. */
.art-doc-headrule { height: 2px; width: 100%; border: 0; border-radius: 2px; margin: 14px 0 0; background: linear-gradient(90deg, var(--art-accent-from), var(--art-accent-to)); }

/* Lede / summary paragraph under the header. */
.art-doc-lede { font-size: var(--art-doc-role); color: var(--art-fg-muted); line-height: 1.5; margin-top: 12px; max-width: 92%; }

/* Section label: uppercase, tracked. Quiet but legible. */
.art-doc-section { font-size: var(--art-doc-section); font-weight: 650; text-transform: uppercase; letter-spacing: 0.14em; color: var(--art-fg-muted); margin: 0 0 10px; }

/* Section header: a label with a hairline trailing to the page edge, carrying
 * the inter-section rhythm. Replaces a stack of identical standalone rules —
 * the label owns the separation and the whole document gains an even cadence. */
.art-doc-sectionhead { display: flex; align-items: center; gap: 14px; margin: 22px 0 12px; }
.art-doc-sectionhead .art-doc-section { margin: 0; flex: 0 0 auto; }
.art-doc-sectionhead::after { content: ""; flex: 1 1 auto; height: 1px; background: var(--art-border); }

/* A plain section separator hairline (kept for one-off use; prefer the
 * section-head cadence above for repeated sections). */
.art-doc-rule { height: 1px; width: 100%; background: var(--art-border); border: 0; margin: 16px 0; }

/* An entry: a job, role, or project. Title + date on one row, description below. */
.art-doc-entry { margin-bottom: 14px; }
.art-doc-entry:last-child { margin-bottom: 0; }
.art-doc-entry-head { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; }
.art-doc-entry-title { min-width: 0; font-size: var(--art-doc-heading); font-weight: 650; line-height: var(--art-doc-line-heading); letter-spacing: -0.01em; }
.art-doc-entry-title span { color: var(--art-fg-muted); font-weight: 450; }
.art-doc-entry-meta { font-size: var(--art-doc-meta); color: var(--art-fg-muted); white-space: nowrap; flex: 0 0 auto; }
.art-doc-entry-desc { color: var(--art-fg-muted); margin-top: 4px; }

/* Two-column footer region (e.g. skills + education), set off by a hairline so
 * it closes the document with the same cadence as a section head. */
.art-doc-cols { display: grid; grid-template-columns: 1.15fr 1fr; gap: 40px; margin-top: 22px; padding-top: 20px; border-top: 1px solid var(--art-border); }

/* Keyword / skill chips: a crisp hairline pill, not a flat grey blob. */
.art-doc-chips { display: flex; flex-wrap: wrap; gap: 7px; }
.art-doc-chip { background: var(--art-surface-raised); border: 1px solid var(--art-border); border-radius: 999px; padding: 4px 12px; font-size: var(--art-doc-meta); color: var(--art-ink); }

/* Decorative aurora: a soft, on-brand gradient wash for pages with large
 * negative space (cover / section / closing). Built from the accent + hue
 * tokens so it can never drift off-palette, and kept faint so ink stays
 * crisp. Author drops a single empty <div class="art-aurora"></div> as a
 * child of the page; NOT for dense content pages. It is absolutely
 * positioned behind content, and the rule below lifts the page's real
 * children above it (scoped with :has so it only affects pages that opt in,
 * and via z-index on the flex items so it never overrides author
 * positioning). */
.art-aurora {
  position: absolute;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
  background:
    radial-gradient(42% 55% at 84% 12%, color-mix(in srgb, var(--art-accent) 38%, transparent), transparent 70%),
    radial-gradient(38% 50% at 8% 90%, color-mix(in srgb, var(--art-hue-sky) 28%, transparent), transparent 70%),
    radial-gradient(30% 42% at 92% 90%, color-mix(in srgb, var(--art-hue-purple) 24%, transparent), transparent 72%);
  filter: blur(10px);
}
.art-page:has(> .art-aurora) > :not(.art-aurora) { z-index: 1; }`;
}

/** The full shell stylesheet: token vars, reset, and primitives. */
function shellStyles(): string {
  return `${rootVariables()}
${RESET}
${baseStyles()}`;
}

/**
 * Wrap model-authored, body-level `bodyHtml` in the full house-shell document
 * for the given `format`. The returned string is a complete standalone page:
 * `<!doctype html>` -> `<head>` (tokens, reset, primitives, locked page
 * box) -> `<body>` -> `.art-page` wrapper -> the author's HTML.
 *
 * Legacy rows that stored a full `<!doctype>` document will double-wrap; that is
 * an accepted tradeoff for a single-user app with disposable historical
 * artifacts (see the plan) and keeps the shell a pure, retroactive render-time
 * transform with no migration.
 */
export function buildArtifactDocument(bodyHtml: string, format: ArtifactFormat = "pdf"): string {
  const { width, height } = pageGeometry[format];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=${width}, height=${height}" />
<style>
${shellStyles()}
</style>
</head>
<body>
<div class="art-page" data-format="${format}">
${bodyHtml}
</div>
</body>
</html>`;
}

/** Minimal HTML-text escape for interpolating a title into `<title>`. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Print-only overrides layered after the shell styles. Sets the physical page
 * size to the format geometry (so the browser's own print engine emits 1:1,
 * one artifact page per sheet, no margins), unlocks the shell's screen-only
 * full-viewport `overflow:hidden` body, and sizes each `.art-print-page` box to
 * the exact geometry with a hard page break between pages.
 */
function printStyles(format: ArtifactFormat): string {
  const { width, height } = pageGeometry[format];
  return `
@page { size: ${width}px ${height}px; margin: 0; }
html, body { width: auto; height: auto; overflow: visible; }
body.art-print { background: #fff; }
.art-print-page {
  position: relative;
  width: ${width}px;
  height: ${height}px;
  overflow: hidden;
  background: var(--art-surface);
  break-after: page;
  page-break-after: always;
}
.art-print-page:last-child { break-after: auto; page-break-after: auto; }
.art-print-page > .art-page { width: 100%; height: 100%; }
/* The print doc is rendered in an off-screen iframe; the screen block just
 * keeps it sane if it is ever opened directly. */
@media screen {
  body.art-print {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    padding: 16px;
    background: #e5e5e5;
  }
}`;
}

/**
 * Build a single print-ready `<!doctype html>` document containing every page
 * of a `kind: "pages"` artifact, for the browser-native "Save as PDF" export
 * (pristine-artifacts Phase 3a). Reuses the exact no-web-font house shell so
 * the export is visually identical to the on-screen render, then layers
 * `printStyles` so the browser's print engine emits one artifact page per
 * physical sheet at 1:1.
 *
 * Each entry in `pages` is body-level page HTML (same contract as
 * `buildArtifactDocument`). `title` seeds `<title>`, which browsers use as the
 * default PDF filename. Pure string output — the caller (web) drives the actual
 * print via an off-screen iframe, since the render iframe is `sandbox=""` and
 * cannot script `print()` itself.
 */
export function buildArtifactPrintDocument(
  pages: readonly string[],
  format: ArtifactFormat = "pdf",
  title = "Artifact",
): string {
  const pageBlocks = pages
    .map(
      (bodyHtml) =>
        `<section class="art-print-page"><div class="art-page" data-format="${format}">
${bodyHtml}
</div></section>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
${shellStyles()}
${printStyles(format)}
</style>
</head>
<body class="art-print">
${pageBlocks}
</body>
</html>`;
}
