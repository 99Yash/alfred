/** One top-level slice of a reply. `start` is its offset in the text, so it is a stable key. */
export interface MarkdownSlice {
  start: number;
  text: string;
}

/** A blank line in CommonMark: only spaces and tabs. A no-break space is content. */
const BLANK = /^[ \t]*\r?$/;

/**
 * A line after a blank line that can still belong to the block above: indented content
 * (a list item continuation, an indented code block) or a list item, which can make the
 * list loose. Such a line never starts a new slice.
 */
const MAY_CONTINUE = /^(?:[ \t]|[-+*](?:[ \t]|\r?$)|\d{1,9}[.)](?:[ \t]|\r?$))/;

/**
 * A link reference or footnote definition acts on the whole text, also from inside a quote
 * or a list item, and its label can wrap lines. Any `]:` outside a fence counts, so a text
 * that may have one is not split.
 */
function mayDefine(line: string): boolean {
  return line.includes("]:");
}

/** HTML block kinds 1 to 5 run across blank lines, so no slice starts after one. */
const HTML_ACROSS_BLANKS =
  /^ {0,3}<(?:(?:script|pre|style|textarea)(?:[ \t>]|\r?$)|!--|\?|![A-Za-z]|!\[CDATA\[)/i;

/** A fence opener: up to 3 spaces, then 3+ backticks (no backtick in the info string) or 3+ tildes. */
const FENCE_OPEN = /^( {0,3})(?:(`{3,})[^`]*|(~{3,}).*)$/;

interface Fence {
  marker: "`" | "~";
  length: number;
  /** An indented opener can sit inside a list item, where a column-0 fence ends the item instead. */
  indented: boolean;
}

function openedFence(line: string): Fence | null {
  const match = FENCE_OPEN.exec(line);
  const run = match?.[2] ?? match?.[3];

  if (!run) return null;

  return {
    marker: run.startsWith("`") ? "`" : "~",
    length: run.length,
    indented: (match?.[1] ?? "").length > 0,
  };
}

function closesFence(line: string, fence: Fence): boolean {
  const body = line.replace(/^ {0,3}/, "");
  let run = 0;

  while (body.charAt(run) === fence.marker) run++;

  return run >= fence.length && BLANK.test(body.slice(run));
}

/**
 * Split markdown into top-level slices that render the same alone as in the whole text,
 * so a streamed reply re-parses only its last slice. A slice ends only at a blank line
 * that is outside a top-level fence and is followed by a line that cannot continue the
 * block above (see {@link MAY_CONTINUE}). A text with a definition stays one slice. After
 * a construct this scan cannot follow (an HTML block that runs across blank lines, an
 * indented fence), the rest of the text is one slice, so earlier slices keep their identity.
 * Joining the slices gives the input back.
 */
export function splitMarkdownBlocks(text: string): MarkdownSlice[] {
  const blocks: MarkdownSlice[] = [];
  let start = 0;
  let offset = 0;
  let fence: Fence | null = null;
  let previousBlank = false;
  let hasContent = false;
  let tailOnly = false;

  for (const line of text.split("\n")) {
    const blank = BLANK.test(line);

    // Past an indented fence this scan may misread a fence, so it checks every line.
    if ((tailOnly || !fence) && mayDefine(line)) return [{ start: 0, text }];

    if (fence) {
      if (closesFence(line, fence)) fence = null;
    } else {
      if (!tailOnly && previousBlank && hasContent && !blank && !MAY_CONTINUE.test(line)) {
        blocks.push({ start, text: text.slice(start, offset) });
        start = offset;
        hasContent = false;
      }

      fence = openedFence(line);

      if (fence?.indented || HTML_ACROSS_BLANKS.test(line)) tailOnly = true;
    }

    if (!blank) hasContent = true;
    previousBlank = blank;
    offset += line.length + 1;
  }

  blocks.push({ start, text: text.slice(start) });

  return blocks;
}
