/**
 * Page checks that `write.ts` runs before it stores an artifact.
 * PDF pages must use the shared type classes, not their own fonts.
 * All pages reject authored `@keyframes` and `animation`: the print/reduced-motion
 * guard would freeze them at a hidden start frame. Transitions are safe, because
 * nothing in the sandbox can trigger them.
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

/** Any `@keyframes`, with or without a vendor prefix. */
const KEYFRAMES_DECLARATION = /@(?:-webkit-|-moz-|-o-|-ms-)?keyframes\b/i;

/** `animation` or `animation-*`. The boundary anchor skips custom properties like `--my-animation:`. */
const ANIMATION_DECLARATION = /(?:^|[;{\s])animation[a-z-]*\s*:/i;

export type PdfArtifactHtmlViolation =
  | "missing-document-root"
  | "art-token-override"
  | "custom-font-family"
  | "custom-font-shorthand"
  | "custom-font-size";

/** Applies to slides and pdf. */
export type MotionViolation = "authored-keyframes" | "authored-animation";

/** `reason` is shown to the model. */
export type ArtifactHtmlValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/** CSS from `<style>` blocks and `style=` attributes only, so prose never trips a check. */
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

/** Authored motion that the shell's guard cannot make safe. */
export function authoredMotionViolations(html: string): readonly MotionViolation[] {
  const violations: MotionViolation[] = [];
  const styles = authoredStyleSources(html).join("\n");

  if (KEYFRAMES_DECLARATION.test(styles)) violations.push("authored-keyframes");

  if (ANIMATION_DECLARATION.test(styles)) violations.push("authored-animation");

  return violations;
}

/** Reads {@link MOTION_CLASS_NAMES}, so the hint names only classes the shell defines. */
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

/** Slides get only the motion check. */
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
