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
 *  - Inject a strict `<meta http-equiv="Content-Security-Policy">` FIRST in
 *    `<head>` (#294). `default-src 'none'` with `img-src data: cid:` means the
 *    Original view makes ZERO requests to sender-controlled hosts on open — no
 *    tracking-pixel beacon, no remote `<img>`/`<video>`/font/`fetch`. It is
 *    safe-by-default even if the HTML were ever rendered outside the sandbox.
 *    The reader re-renders this same document with a looser `img-src` only when
 *    the user clicks "Display remote media" per message. `base-uri 'none'`
 *    restricts a `<base href>` URL, not the `target` attribute, so it does not
 *    fight the `<base target="_blank">` above.
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
  // Re-inject the CSP `<meta>` + `<base>` after sanitization — DOMPurify strips
  // `<meta>` and `<link>` along with anything else that could redirect, so the
  // safer path is to write the tags back ourselves once the dangerous markup is
  // gone. The CSP meta goes FIRST so it governs everything that follows.
  // `<base>` doesn't accept `rel`; modern browsers default to `noopener` for
  // `target="_blank"` so we get the safety guarantee without invalid markup.
  const headTags = `${EMAIL_CSP_META}<base target="_blank">`;
  if (/<head\b[^>]*>/i.test(cleaned)) {
    return cleaned.replace(/<head\b[^>]*>/i, (m) => `${m}${headTags}`);
  }
  if (/<html\b[^>]*>/i.test(cleaned)) {
    return cleaned.replace(/<html\b[^>]*>/i, (m) => `${m}<head>${headTags}</head>`);
  }
  return `<!doctype html><html><head>${headTags}</head><body>${cleaned}</body></html>`;
}

/**
 * Strict CSP for the Original email view (#294): no network at all except inline
 * (`cid:`) and `data:` images, with inline `<style>` allowed so the email's own
 * typography survives. Baked first in `<head>`; the reader swaps only `img-src`
 * /`media-src` when the user opts into remote media. Exported so the web reader
 * can match-and-replace this exact meta tag for the looser variant.
 */
export const EMAIL_CSP_META =
  `<meta http-equiv="Content-Security-Policy" content="` +
  `default-src 'none'; img-src data: cid:; media-src 'none'; font-src 'none'; ` +
  `connect-src 'none'; frame-src 'none'; object-src 'none'; script-src 'none'; ` +
  `style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">`;
