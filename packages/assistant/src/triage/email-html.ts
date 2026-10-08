import DOMPurify from "isomorphic-dompurify";

/**
 * Sanitize email HTML for the rail's sandboxed iframe (defense in depth).
 * Keeps `<style>`; drops scripts, frames, forms and `on*` handlers. Adds a strict
 * CSP first in `<head>` (#294) so opening mail loads nothing remote, plus
 * `<base target="_blank">`. Null when nothing survives.
 */
export function sanitizeEmailHtml(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();

  if (!trimmed) return null;

  const cleaned = DOMPurify.sanitize(trimmed, {
    WHOLE_DOCUMENT: true,
    FORBID_TAGS: [
      "script",
      "iframe",
      "object",
      "embed",
      "form",
      "input",
      "button",
      "textarea",
      "select",
      "option",
      "meta",
      "link",
    ],
    FORBID_ATTR: [
      "onerror",
      "onload",
      "onclick",
      "onmouseover",
      "onmouseenter",
      "onmouseleave",
      "onfocus",
      "onblur",
      "onsubmit",
      "onchange",
      "oninput",
      "onkeydown",
      "onkeyup",
      "onkeypress",
      "onbeforeunload",
      "formaction",
      "action",
    ],
    // Blocks `javascript:` and friends; `data:` images stay for transactional mail.
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|cid:|data:image\/)/i,
  });

  if (!cleaned || !cleaned.trim()) return null;
  // DOMPurify strips `<meta>`, so add the CSP back first. `<base>` takes no `rel`;
  // browsers default `_blank` to `noopener`.
  const headTags = `${EMAIL_CSP_META}<base target="_blank">`;

  if (/<head\b[^>]*>/i.test(cleaned)) {
    return cleaned.replace(/<head\b[^>]*>/i, (m) => `${m}${headTags}`);
  }

  if (/<html\b[^>]*>/i.test(cleaned)) {
    return cleaned.replace(/<html\b[^>]*>/i, (m) => `${m}<head>${headTags}</head>`);
  }

  return `<!doctype html><html><head>${headTags}</head><body>${cleaned}</body></html>`;
}

/** Exported so the web reader can swap `img-src`/`media-src` when the user allows remote media. */
export const EMAIL_CSP_META =
  `<meta http-equiv="Content-Security-Policy" content="` +
  `default-src 'none'; img-src data: cid:; media-src 'none'; font-src 'none'; ` +
  `connect-src 'none'; frame-src 'none'; object-src 'none'; script-src 'none'; ` +
  `style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">`;
