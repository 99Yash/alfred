/** HTML entity escape and decode. Browser-safe; the tag strip stays with each caller. */

import { keyGuard } from "./guards";

/** Escape text for HTML element content or a quoted attribute. `&` goes first. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  bull: "•",
} satisfies Record<string, string>;

const isNamedEntity = keyGuard(NAMED_ENTITIES);

/**
 * Decode the HTML entities a text reader actually encounters, in one pass,
 * so `&amp;lt;` reads `&lt;`. Unknown named entities stay as written.
 */
export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const codePoint =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);

      // Reject surrogates: `&#xD800;` would decode to invalid UTF-16.
      if (
        Number.isFinite(codePoint) &&
        codePoint > 0 &&
        codePoint <= 0x10ffff &&
        !(codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return whole;
        }
      }

      return whole;
    }

    const name = body.toLowerCase();

    return isNamedEntity(name) ? NAMED_ENTITIES[name] : whole;
  });
}
