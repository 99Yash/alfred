import DOMPurify from "isomorphic-dompurify";

/**
 * Sanitize an inbound email HTML body for in-rail iframe rendering.
 *
 * We render the result inside `<iframe srcDoc>` with sandbox flags that
 * already block scripts and same-origin access — sanitization is the
 * defense-in-depth layer. Strategy:
 *
 *  - Keep `<style>` so the email's own typography survives. Layout-heavy
 *    marketing emails will still look pretty rough at rail width, but
 *    transactional mail (receipts, invoices) renders close to native.
 *  - Strip `<script>` / `<iframe>` / form elements and every `on*` event
 *    attribute. The CSP-equivalent set DOMPurify enforces is fine; we
 *    add a few extras (`form`, `input`, `button`) because emails should
 *    not be soliciting input — anything that did was a phish.
 *  - Inject `<base target="_blank" rel="noopener noreferrer">` so any
 *    link inside the iframe opens in a new tab rather than navigating the
 *    sandboxed frame to a blank page the user can't recover.
 *
 * Returns null when the input is empty or sanitization erases the body
 * entirely — the reader falls back to its markdown view in that case.
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
    // Disallow non-http(s)/mailto schemes (excludes javascript:, data: in
    // hrefs, tel:, etc.). Inline data: images are still allowed via the
    // URL profile because they're a common pattern for transactional mail.
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|cid:|data:image\/)/i,
  });
  if (!cleaned || !cleaned.trim()) return null;
  // Re-inject the `<base>` after sanitization — DOMPurify strips `<meta>`
  // and `<link>` along with anything else that could redirect, so the safer
  // path is to write the tag back ourselves once the dangerous markup is gone.
  // `<base>` doesn't accept `rel`; modern browsers default to `noopener` for
  // `target="_blank"` so we get the safety guarantee without invalid markup.
  const baseTag = `<base target="_blank">`;
  if (/<head\b[^>]*>/i.test(cleaned)) {
    return cleaned.replace(/<head\b[^>]*>/i, (m) => `${m}${baseTag}`);
  }
  if (/<html\b[^>]*>/i.test(cleaned)) {
    return cleaned.replace(/<html\b[^>]*>/i, (m) => `${m}<head>${baseTag}</head>`);
  }
  return `<!doctype html><html><head>${baseTag}</head><body>${cleaned}</body></html>`;
}
