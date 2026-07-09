import { archetypes } from "./archetypes";
import { houseTheme } from "./theme";
import { accent, pageGeometry } from "./tokens";

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
 * names) so it can never drift from what the shell actually renders.
 */
function buildArtifactDesignPrompt(): string {
  const slides = pageGeometry.slides;
  const pdf = pageGeometry.pdf;
  const archetypeList = archetypes.map((a) => `${a.name} (${a.description})`).join("; ");

  return [
    "## Authoring artifact pages",
    `When you author a \`pages\` artifact (create_artifact + append_artifact_page), each page is wrapped in the Alfred house shell at render time. The shell provides the brand font (Open Runde), a color/spacing/type token system, a CSS reset, and a class vocabulary. You write only the page BODY.`,
    [
      "Hard rules:",
      "- Write body-level HTML only. Never emit <html>, <head>, <body>, <!doctype>, <script>, or external <link>/CDN tags. Scripts do not run (the page is sandboxed).",
      `- Never set page width/height or margins on the root, and never fix a background on <body>: the shell owns page geometry (slides are ${slides.width}x${slides.height}, pdf pages ${pdf.width}x${pdf.height}) and the white surface.`,
      "- Everything must fit inside the page box. There is no scrolling; overflow is clipped. Keep content per page small, use one idea per page, and prefer more pages over a crammed one.",
      "- Use the provided classes and tokens; a small inline `style` for one-off tuning (a width %, a gap) is fine. Do not restyle the whole page from scratch.",
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
    ].join("\n"),
    `Pick ONE layout archetype per page and keep the whole deck on the same theme: ${archetypeList}.`,
    [
      "Example page body (Title archetype):",
      '<div class="art-center art-stack">',
      '  <span class="art-eyebrow">Quarterly review</span>',
      '  <h1 class="art-display">The year in one page</h1>',
      '  <p class="art-subhead art-muted">What moved, what stalled, and where we go next.</p>',
      "</div>",
    ].join("\n"),
  ].join("\n\n");
}

/**
 * The generated, cache-stable design-system prompt. A module-level constant so
 * the exact same string is appended every turn (a fresh build per call would
 * still be identical, but a constant makes the cache-stability contract
 * explicit and avoids rebuilding the string on every prompt assembly).
 */
export const ARTIFACT_DESIGN_PROMPT: string = buildArtifactDesignPrompt();
