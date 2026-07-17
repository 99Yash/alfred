/**
 * Deterministic authoring contract for artifact pages.
 *
 * Two concerns live here, both enforced at the write boundary (`write.ts`):
 *
 *  1. **Document typography (pdf only).** The shell intentionally allows small
 *     inline styles for geometry, but document typography must come from the
 *     shared classes/tokens. Rejecting custom font declarations prevents a
 *     model-authored page stylesheet from recreating the tiny/off-brand type
 *     scale that the document medium exists to eliminate.
 *
 *  2. **Motion safety (slides AND pdf).** The shell owns ONE central
 *     `@media print, (prefers-reduced-motion: reduce)` guard that forces
 *     `animation: none` — which snaps every shell motion class to its RESTING
 *     frame (authored to equal the final visible frame). That guard only covers
 *     the shell's own selectors. If a model authored its OWN `@keyframes` with a
 *     hidden base state (`opacity: 0`, an off-screen `transform`), the guard
 *     would freeze it at that base — invisible in print/reduced-motion. So the
 *     hole is closed here: authored `@keyframes` and `animation`/`animation-*`
 *     declarations are rejected outright. Motion may come ONLY from the guarded
 *     shell classes (`MOTION_CLASS_NAMES`). Transitions are NOT rejected — a
 *     transition needs a property change to fire, which cannot happen in a static
 *     `pointer-events: none` sandbox, so it always rests at its declared state
 *     and is safe by construction.
 *
 * The slide check is motion-ONLY: it deliberately does not impose the pdf
 * font/root rules, so slides keep their inline-geometry freedom.
 */

import { MOTION_CLASS_NAMES } from "./shell";

const DOCUMENT_ROOT_CLASS =
  /^\s*(?:(?:<!--[\s\S]*?-->|<style\b[^>]*>[\s\S]*?<\/style\s*>)\s*)*<([a-z][\w:-]*)\b[^>]*\bclass\s*=\s*(["'])[^"']*\bart-doc\b[^"']*\2[^>]*>/i;
const ART_TOKEN_OVERRIDE = /--art-[a-z0-9-]+\s*:/i;
const FONT_FAMILY_DECLARATION = /\bfont-family\s*:/i;
const FONT_SHORTHAND_DECLARATION = /(?:^|[;{\s])font\s*:/i;
const FONT_SIZE_DECLARATION = /\bfont-size\s*:\s*([^;"'}]+)/gi;
const ALLOWED_DOCUMENT_FONT_SIZE =
  /^var\(--art-doc-(?:name|role|section|heading|body|meta)\)\s*(?:!important\s*)?$/i;

/**
 * Any `@keyframes` block (with or without a vendor prefix). Only the shell may
 * define keyframes; an authored one has no central guard and can hide content.
 */
const KEYFRAMES_DECLARATION = /@(?:-webkit-|-moz-|-o-|-ms-)?keyframes\b/i;
/**
 * An `animation` / `animation-*` property. The leading `(?:^|[;{\s])` anchors it
 * to a real declaration start so it matches `animation:` and `animation-delay:`
 * but NOT a custom property like `--my-animation:` (whose preceding char is a
 * hyphen, not a declaration boundary).
 */
const ANIMATION_DECLARATION = /(?:^|[;{\s])animation[a-z-]*\s*:/i;

export type PdfArtifactHtmlViolation =
  | "missing-document-root"
  | "art-token-override"
  | "custom-font-family"
  | "custom-font-shorthand"
  | "custom-font-size";

/** Motion violations apply to every `pages` format (slides + pdf). */
export type MotionViolation = "authored-keyframes" | "authored-animation";

/** A validation outcome: ok, or a rejection carrying a model-facing reason. */
export type ArtifactHtmlValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/** Inspect CSS declaration contexts, not visible prose or code examples. */
function authoredStyleSources(html: string): string[] {
  const sources: string[] = [];
  for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    if (match[1]) sources.push(match[1]);
  }
  for (const match of html.matchAll(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/gi)) {
    if (match[2]) sources.push(match[2]);
  }
  return sources;
}

/**
 * Authored motion the central guard cannot make safe. Scans the same authored
 * style sources the pdf rules use, so it never trips on visible prose that
 * merely mentions "animation".
 */
export function authoredMotionViolations(html: string): readonly MotionViolation[] {
  const violations: MotionViolation[] = [];
  const styles = authoredStyleSources(html).join("\n");
  if (KEYFRAMES_DECLARATION.test(styles)) violations.push("authored-keyframes");
  if (ANIMATION_DECLARATION.test(styles)) violations.push("authored-animation");
  return violations;
}

/**
 * The model-facing hint for a motion rejection, shared by both formats. Names
 * the allowed classes from {@link MOTION_CLASS_NAMES} (the shell's own list) so
 * the hint can never drift into advertising a class the shell does not define.
 */
function motionRejectionHint(): string {
  return `Do not author @keyframes or animation declarations: motion has no print/reduced-motion guard when authored and can freeze content hidden. Use the shell motion classes instead (${MOTION_CLASS_NAMES.join(", ")}).`;
}

export function pdfArtifactHtmlViolations(
  html: string,
): readonly (PdfArtifactHtmlViolation | MotionViolation)[] {
  const violations: (PdfArtifactHtmlViolation | MotionViolation)[] = [];
  if (!DOCUMENT_ROOT_CLASS.test(html)) violations.push("missing-document-root");
  const styles = authoredStyleSources(html).join("\n");
  if (ART_TOKEN_OVERRIDE.test(styles)) violations.push("art-token-override");
  if (FONT_FAMILY_DECLARATION.test(styles)) violations.push("custom-font-family");
  if (FONT_SHORTHAND_DECLARATION.test(styles)) violations.push("custom-font-shorthand");

  for (const match of styles.matchAll(FONT_SIZE_DECLARATION)) {
    const value = match[1]?.trim() ?? "";
    if (!ALLOWED_DOCUMENT_FONT_SIZE.test(value)) {
      violations.push("custom-font-size");
      break;
    }
  }
  violations.push(...authoredMotionViolations(html));
  return violations;
}

export function validatePdfArtifactHtml(html: string): ArtifactHtmlValidation {
  const violations = pdfArtifactHtmlViolations(html);
  if (violations.length === 0) return { ok: true };
  const hasMotion = violations.some(
    (v) => v === "authored-keyframes" || v === "authored-animation",
  );
  const hasDoc = violations.some((v) => v !== "authored-keyframes" && v !== "authored-animation");
  const hints: string[] = [];
  if (hasDoc) hints.push("Use the art-doc root and shared typography classes/tokens.");
  if (hasMotion) hints.push(motionRejectionHint());
  return {
    ok: false,
    reason: `PDF page rejected by the authoring contract: ${violations.join(", ")}. ${hints.join(" ")}`,
  };
}

/**
 * Slide pages are unvalidated for typography (they keep inline-geometry
 * freedom), but motion is enforced for every format: authored keyframes /
 * animations are rejected so only the guarded shell classes can animate.
 */
export function slideArtifactHtmlViolations(html: string): readonly MotionViolation[] {
  return authoredMotionViolations(html);
}

export function validateSlideArtifactHtml(html: string): ArtifactHtmlValidation {
  const violations = slideArtifactHtmlViolations(html);
  if (violations.length === 0) return { ok: true };
  return {
    ok: false,
    reason: `Slide page rejected by the authoring contract: ${violations.join(", ")}. ${motionRejectionHint()}`,
  };
}
