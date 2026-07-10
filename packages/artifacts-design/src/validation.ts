/**
 * Deterministic authoring contract for portrait PDF pages.
 *
 * The shell intentionally allows small inline styles for geometry, but document
 * typography must come from the shared classes/tokens. Rejecting custom font
 * declarations prevents a model-authored page stylesheet from recreating the
 * tiny/off-brand type scale that the document medium exists to eliminate.
 */

const DOCUMENT_ROOT_CLASS =
  /^\s*(?:(?:<!--[\s\S]*?-->|<style\b[^>]*>[\s\S]*?<\/style\s*>)\s*)*<([a-z][\w:-]*)\b[^>]*\bclass\s*=\s*(["'])[^"']*\bart-doc\b[^"']*\2[^>]*>/i;
const ART_TOKEN_OVERRIDE = /--art-[a-z0-9-]+\s*:/i;
const FONT_FAMILY_DECLARATION = /\bfont-family\s*:/i;
const FONT_SHORTHAND_DECLARATION = /(?:^|[;{\s])font\s*:/i;
const FONT_SIZE_DECLARATION = /\bfont-size\s*:\s*([^;"'}]+)/gi;
const ALLOWED_DOCUMENT_FONT_SIZE =
  /^var\(--art-doc-(?:name|role|section|heading|body|meta)\)\s*(?:!important\s*)?$/i;

export type PdfArtifactHtmlViolation =
  | "missing-document-root"
  | "art-token-override"
  | "custom-font-family"
  | "custom-font-shorthand"
  | "custom-font-size";

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

export function pdfArtifactHtmlViolations(html: string): readonly PdfArtifactHtmlViolation[] {
  const violations: PdfArtifactHtmlViolation[] = [];
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
  return violations;
}

export function validatePdfArtifactHtml(
  html: string,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  const violations = pdfArtifactHtmlViolations(html);
  if (violations.length === 0) return { ok: true };
  return {
    ok: false,
    reason:
      "PDF page rejected by the document authoring contract: " +
      `${violations.join(", ")}. Use the art-doc root and shared typography classes/tokens.`,
  };
}
