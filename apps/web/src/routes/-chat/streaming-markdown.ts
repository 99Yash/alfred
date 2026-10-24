import remend from "remend";

/** A delimiter row (`|---|:--:|`), maybe half-typed. */
const TABLE_DELIMITER = /^\s*\|?[\s:|-]*-[\s:|-]*$/;

/**
 * While streaming, hide a trailing table until its first data row starts.
 * Before the delimiter row is complete, remark-gfm shows the header as raw pipes.
 */
function hideIncompleteTableTail(text: string): string {
  // Skip the O(n) split per token unless the last non-blank line has a pipe.
  let last = text.length - 1;

  while (last >= 0 && /\s/.test(text.charAt(last))) last--;

  if (last < 0) return text; // all blank
  const lastLineStart = text.lastIndexOf("\n", last) + 1;

  if (!text.slice(lastLineStart, last + 1).includes("|")) return text;

  const lines = text.split("\n");
  // A header that just got its newline is still a fragment.
  let end = lines.length - 1;

  while (end >= 0 && lines[end]?.trim() === "") end--;

  if (end < 0) return text;
  let start = end + 1;

  for (let i = end; i >= 0; i--) {
    if (lines[i]?.includes("|")) start = i;
    else break;
  }

  if (start > end) return text; // no trailing pipe lines
  const block = lines.slice(start, end + 1);

  // Prose with an inline `|` does not start the line with a pipe.
  if (!/^\s*\|/.test(block[0] ?? "")) return text;
  const dataRowStarted = block.length > 2 && TABLE_DELIMITER.test(block[1] ?? "");

  if (dataRowStarted) return text; // valid table

  return lines.slice(0, start).join("\n"); // hold back the header
}

/**
 * Stop half-typed markdown from showing raw markers while streaming.
 * `remend` closes open inline tokens and shows a half-typed link as text.
 * Set `math` only where the renderer has a math plugin; it closes an open `$$` block.
 * The final body is not touched.
 */
export function healStreamingMarkdown(text: string, { math }: { math: boolean }): string {
  return remend(hideIncompleteTableTail(text), { linkMode: "text-only", katex: math });
}
