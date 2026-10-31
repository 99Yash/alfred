import {
  type BriefingGather,
  collapseWhitespace,
  resolveBriefingReferences,
} from "@alfred/contracts";

/** Composer prose as plain text: resolved tokens become labels, others their inner id. */
export function briefingPlainText(markdown: string, gather: BriefingGather | null): string {
  if (!gather) return markdown.replace(/\[\[[a-z_]+:([^\]\s]+)\]\]/g, "$1");

  return resolveBriefingReferences(markdown, gather)
    .segments.map((segment) => (segment.kind === "text" ? segment.text : segment.label))
    .join("");
}

/**
 * Composer prose as one plain line for the briefings-list gist: resolves tokens, then
 * strips headings, bullets, blockquotes, emphasis, inline code, and link/image syntax.
 * Emphasis markers go only in pairs, and `_` only at a word edge, so `installation_id`,
 * `file_name.ts`, and `2*3` keep their characters.
 */
export function briefingGist(markdown: string, gather: BriefingGather | null): string {
  return collapseWhitespace(
    briefingPlainText(markdown, gather)
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images → alt text
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links → link text
      .replace(/^\s{0,3}#{1,6}\s+/gm, "") // ATX heading markers
      .replace(/^\s{0,3}>\s?/gm, "") // blockquote markers
      .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, "") // list bullets / ordinals
      .replace(/`+([^`]+?)`+/g, "$1") // inline code → its text
      .replace(/~~(?=\S)(.*?\S)~~/g, "$1") // strikethrough
      .replace(/(\*{1,3})(?=\S)([^*]*?\S)\1/g, "$2") // `*` emphasis, also intraword
      .replace(/(^|[^\p{L}\p{N}_])(_{1,3})(?=\S)(.*?\S)\2(?![\p{L}\p{N}_])/gmu, "$1$3"), // `_` emphasis at word edges
  );
}
