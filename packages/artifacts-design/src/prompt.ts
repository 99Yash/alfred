import { archetypes } from "./archetypes";
import { documentTemplateById, documentTemplates } from "./templates";
import { houseTheme } from "./theme";
import { accent, docType, pageGeometry, type } from "./tokens";

/**
 * The design-system block injected into the artifact-authoring turn
 * (pristine-artifacts Phase 1). Deliberately LEAN: it teaches the shell
 * contract, names the primitive vocabulary and archetypes, and states the
 * hard rules — it does NOT dump full exemplar HTML (those live in-package as
 * fixtures). It is identical across every page call, so it is appended at a
 * cache-stable position in the chat system prompt and rides the prompt cache;
 * bounding its size bounds the recurring token cost.
 *
 * Built from the token/theme source of truth (accent, page geometry, archetype
 * names, document type scale) so it can never drift from what the shell renders.
 * Covers both mediums: SLIDES (the art-* vocabulary + layout archetypes) and
 * DOCUMENTS (the denser art-doc-* vocabulary + the resume template, inlined as
 * the anchor because naming alone let the model free-style a resume off-system).
 */
function buildArtifactDesignPrompt(): string {
  const slides = pageGeometry.slides;
  const pdf = pageGeometry.pdf;
  const archetypeList = archetypes.map((a) => `${a.name} (${a.description})`).join("; ");
  const docTemplateList = documentTemplates.map((t) => `${t.name} (${t.description})`).join("; ");
  const resumeTemplate = documentTemplateById("resume");

  return [
    "## Authoring artifact pages",
    `When you author a \`pages\` artifact (create_artifact + append_artifact_page), each page is wrapped in the Alfred house shell at render time. The shell provides a house typography stack (Open Runde when available, then system sans), a color/spacing/type token system, a CSS reset, and a class vocabulary. You write only the page BODY.`,
    [
      "Hard rules:",
      "- Write body-level HTML only. Never emit <html>, <head>, <body>, <!doctype>, <script>, or external <link>/CDN tags. Scripts do not run (the page is sandboxed).",
      `- Never set page width/height or margins on the root, and never fix a background on <body>: the shell owns page geometry (slides are ${slides.width}x${slides.height}, pdf pages ${pdf.width}x${pdf.height}) and the white surface.`,
      "- Do NOT add your own padding or margin to the top-level wrapper. The shell already insets the page from every edge; extra outer padding stacks on top of it, shrinks the usable box, and pushes content off the bottom. Let the shell own the edge inset and only space elements WITHIN the content.",
      "- Everything must fit inside the page box. There is no scrolling; overflow is clipped. Author light: one idea per page, prefer more pages over a crammed one. As a budget, a slide holds roughly a heading plus 4-6 short lines or 3 small cards; if you have more, split it across pages.",
      "- Balance the page. Choose type sizes and spacing so content reads complete, not crammed into the top. Even, generous spacing between sections beats one large gap; some trailing whitespace at the bottom of a short page is fine, a void in the middle is not.",
      `- The house token system is the source of truth: extend it, never replace it. If you add an inline \`<style>\`, reference the tokens (color: var(--art-ink), var(--art-fg-muted), var(--art-accent), and the shell's font) rather than hardcoding hex colors or naming a different font, and never set a base font-size below the medium body size (slides ${type.body}, documents ${docType.body}). A small inline style for one-off geometry (a width %, a gap, a grid) is fine; rebuilding the page look from scratch (a full page-level stylesheet with its own palette and tiny type) is not, and reads off-brand.`,
      "- For code, use a <pre> block (or the art-code class), not a hand-styled box. Keep each block short (about 12 lines max) and lines under ~60 characters; long lines wrap and tall blocks are clipped. Split long code across pages.",
      "- Voice: plain, confident, concrete. No em-dashes (use a period, comma, or colon). No emoji.",
    ].join("\n"),
    [
      `Theme — ${houseTheme.name}: ${houseTheme.voice} Accent is a purple gradient (${accent.from} to ${accent.to}); use it sparingly for one emphasis per page.`,
      "Root wrapper class is `art-page` (the shell adds it). Compose with these primitives:",
      "- Layout: art-stack, art-row, art-grid-2, art-split, art-center, art-between, art-fill, art-grow, art-wrap.",
      "- Type: art-display, art-title, art-headline, art-subhead, art-body, art-caption, art-eyebrow.",
      "- Color: art-ink, art-muted, art-subtle, art-accent-text.",
      "- Surfaces/marks: art-card, art-panel, art-badge, art-rule, art-accent-mark, art-dot.",
      "- Data: art-stat-value + art-stat-label; art-bar-track + art-bar-fill (a pure-CSS bar, sized with an inline width %); art-list (accent-marked bullets).",
      "- Code: a <pre> block (styled by the shell) or art-code for multi-line code; inline `<code>` for a token in prose.",
      '- Decor: art-aurora, a soft on-brand gradient wash for negative space. Drop a single empty `<div class="art-aurora"></div>` as a child of the page and the shell draws it behind your content.',
    ].join("\n"),
    `Pick ONE layout archetype per page and keep the whole deck on the same theme: ${archetypeList}.`,
    "Use art-aurora only on sparse pages that carry a large empty area (cover, section divider, closing) to fill negative space; never on a content-dense page, and at most one per page. Scale it to the subject: skip it or keep decks minimal for serious or technical material, and reserve it for lighter, marketing, or celebratory decks. When in doubt, leave it off; plain white is always on-brand.",
    [
      "Example page body (Title archetype):",
      '<div class="art-center art-stack">',
      '  <span class="art-eyebrow">Quarterly review</span>',
      '  <h1 class="art-display">The year in one page</h1>',
      '  <p class="art-subhead art-muted">What moved, what stalled, and where we go next.</p>',
      "</div>",
    ].join("\n"),
    [
      `Documents (\`pdf\` format) are a DIFFERENT medium from slides: a portrait page (${pdf.width}x${pdf.height}) read up close, so it is denser and type is smaller. Do not carry the big slide type onto a document. Build hierarchy from weight and the document type scale, and use the art-doc-* vocabulary:`,
      `- Type scale (font-size, use the class): art-doc-name (${docType.name}) for the person or document name; art-doc-role (${docType.role}) for the role or subtitle; art-doc-heading (${docType.heading}) for an entry title; art-doc-body (${docType.body}) for copy; art-doc-meta (${docType.meta}) for dates and captions; art-doc-section (${docType.section}, uppercase, tracked) for a section label. ${docType.body} is the readable floor.`,
      "- Structure: wrap the page in `art-doc`. Then art-doc-header (name and role on the left, art-doc-contact stack on the right), art-doc-headrule (the accent hairline under the header), art-doc-lede (a one-line summary), then each section as art-doc-sectionhead wrapping an art-doc-section label (draws the label with a trailing hairline and the right spacing above it — use this for repeated sections instead of stacking art-doc-rule). An art-doc-entry holds art-doc-entry-head (art-doc-entry-title with a muted `<span>` for the org, plus art-doc-entry-meta for the date) and art-doc-entry-desc. Use art-doc-cols for a two-column footer (it draws its own top hairline), art-doc-chips + art-doc-chip for skills or tags.",
      "- Accent restraint: a document gets ONE brand moment. Use art-doc-headrule under the header and let links carry the accent; do not tint section labels or repeat accent bars. That single-accent discipline is what separates a professional document from a brochure.",
      "- Let the document flow top to bottom with even spacing between sections; the section-head cadence provides it. Thin content should breathe rather than pile up at the top; trailing whitespace at the bottom is fine. Do not force a footer to the page bottom with a spacer, which strands a gap in the middle.",
      "- Fit the page: a document is a single clipped sheet, not a scroll. Keep it to what fits with air to spare. For a resume that means the most recent 4 to 5 roles, one to two lines each, plus a short skills and education footer; if there is more history, tighten or drop the oldest rather than let the last section run off the bottom. Prefer fewer, sharper lines over dense paragraphs.",
    ].join("\n"),
    `Document templates to adapt (keep the structure and classes, swap in the real facts): ${docTemplateList}. Reference resume:`,
    resumeTemplate ? resumeTemplate.html : "",
  ].join("\n\n");
}

/**
 * The generated, cache-stable design-system prompt. A module-level constant so
 * the exact same string is appended every turn (a fresh build per call would
 * still be identical, but a constant makes the cache-stability contract
 * explicit and avoids rebuilding the string on every prompt assembly).
 */
export const ARTIFACT_DESIGN_PROMPT: string = buildArtifactDesignPrompt();
