/**
 * Deterministic dash cleanup for Alfred's own prose. A lexer, not a regex: it skips code
 * and quotes, and a stream gives the same output as the whole string at any chunk boundary.
 */

export interface VoiceStreamSanitizer {
  /** Returns the text that is safe to emit now. */
  push(raw: string): string;
  /** Returns any held-back punctuation or whitespace. */
  flush(): string;
}

interface PendingDash {
  char: "—" | "–" | "--";

  before: string;
}

function withoutTrailingHorizontalSpace(value: string): string {
  return value.replace(/[ \t]+$/g, "");
}

function hasLineBreak(value: string): boolean {
  return value.includes("\n") || value.includes("\r");
}

/** Delimiters, whitespace, and a pending dash can span chunks, so each is kept as state. */
export function createVoiceStreamSanitizer(): VoiceStreamSanitizer {
  let output = "";
  let mode: "prose" | "code" = "prose";
  let codeDelimiterLength = 0;
  let tickBuffer = "";
  let pendingHyphenBefore: string | null = null;
  let whitespace = "";
  let pendingDash: PendingDash | null = null;
  let previousProseNonSpace = "";
  let asciiQuoteOpen = false;
  let curlyQuoteOpen = false;
  let atLineStart = true;
  let blockQuoteLine = false;
  let markdownDestinationDepth = 0;
  let previousInputChar = "";
  let currentProseToken = "";
  let lineStartHyphens = "";
  let structuralMarkdownLine = false;
  // A possible table delimiter row (`| --- |`), held until a newline or a prose character decides.
  let structuralPipeScan: string | null = null;
  let replayingPipeScan = false;

  const takeOutput = (): string => {
    const next = output;
    output = "";

    return next;
  };

  const emitWhitespace = (): void => {
    output += whitespace;

    if (whitespace.length > 0) currentProseToken = "";
    whitespace = "";
  };

  const emitSingleHyphen = (): void => {
    if (pendingHyphenBefore === null) return;
    output += `${pendingHyphenBefore}-`;
    currentProseToken = pendingHyphenBefore.length > 0 ? "-" : `${currentProseToken}-`;
    previousProseNonSpace = "-";
    pendingHyphenBefore = null;
  };

  const tokenNeedsExactPunctuation = (): boolean =>
    currentProseToken.includes("://") ||
    currentProseToken.startsWith("www.") ||
    currentProseToken.startsWith("mailto:") ||
    currentProseToken.includes("@");

  const resolveLineStartHyphensAsProse = (): void => {
    if (lineStartHyphens.length === 0) return;

    if (lineStartHyphens.length === 1) {
      pendingHyphenBefore = whitespace;
    } else {
      pendingDash = { char: "--", before: whitespace };
    }

    whitespace = "";
    lineStartHyphens = "";
  };

  const resolveDash = (): void => {
    if (!pendingDash) return;
    const before = pendingDash.before;
    const after = whitespace;

    if (pendingDash.char === "–") {
      // An en dash can be a range or a separator. A hyphen keeps both meanings.
      output += `${before}-${after}`;
    } else {
      // Keep line breaks. On one line, use a semicolon, not a comma splice.
      const beforeBreak = hasLineBreak(before) ? withoutTrailingHorizontalSpace(before) : "";
      const afterBreak = hasLineBreak(after) ? withoutTrailingHorizontalSpace(after) : "";

      if (beforeBreak || afterBreak) {
        output += beforeBreak || afterBreak;
      } else if (previousProseNonSpace && !/[.!?:;,]/.test(previousProseNonSpace)) {
        output += "; ";
      } else if (previousProseNonSpace) {
        output += " ";
      }
    }

    pendingDash = null;
    whitespace = "";
    currentProseToken = "";
  };

  const emitProseChar = (char: string): void => {
    if (char === "—" || char === "–") {
      if (whitespace.length === 0 && tokenNeedsExactPunctuation()) {
        emitWhitespace();
        output += char;
        currentProseToken += char;
        previousProseNonSpace = char;

        return;
      }

      // A run of dashes is one separator.
      pendingDash = { char, before: pendingDash?.before ?? whitespace };
      whitespace = "";

      return;
    }

    if (/\s/u.test(char)) {
      whitespace += char;

      if (char === "\n" || char === "\r") atLineStart = true;

      return;
    }

    resolveDash();
    emitWhitespace();
    output += char;
    currentProseToken += char;
    previousProseNonSpace = char;
    atLineStart = false;
  };

  const resolveTicks = (): void => {
    if (tickBuffer.length === 0) return;

    if (mode === "prose") {
      resolveDash();
      emitWhitespace();
      output += tickBuffer;
      mode = "code";
      codeDelimiterLength = tickBuffer.length;
    } else {
      output += tickBuffer;

      if (tickBuffer.length >= codeDelimiterLength) {
        mode = "prose";
        codeDelimiterLength = 0;
      }
    }

    tickBuffer = "";
  };

  const processChar = (char: string): void => {
    const priorInputChar = previousInputChar;
    previousInputChar = char;

    if (structuralMarkdownLine) {
      output += char;

      if (char === "\n" || char === "\r") {
        structuralMarkdownLine = false;
        atLineStart = true;
      }

      return;
    }

    if (structuralPipeScan !== null) {
      if (char === "\n" || char === "\r") {
        // A table delimiter row. Emit it as is, or the table breaks.
        output += structuralPipeScan + char;
        structuralPipeScan = null;
        atLineStart = true;

        return;
      }

      if (char === "|" || char === "-" || char === ":" || char === " " || char === "\t") {
        structuralPipeScan += char;

        return;
      }

      // A content row, not a delimiter. Replay the buffer, then handle this character.
      const buffered = structuralPipeScan;
      structuralPipeScan = null;
      replayingPipeScan = true;

      for (const bufferedChar of buffered) processChar(bufferedChar);
      replayingPipeScan = false;
      previousInputChar = char; // the replay overwrote it
    }

    if (lineStartHyphens.length > 0) {
      if (char === "-") {
        lineStartHyphens += char;

        if (lineStartHyphens.length === 3) {
          resolveDash();
          emitWhitespace();
          output += lineStartHyphens;
          lineStartHyphens = "";
          structuralMarkdownLine = true;
          atLineStart = false;
        }

        return;
      }

      resolveLineStartHyphensAsProse();
    }

    if (markdownDestinationDepth > 0) {
      output += char;

      if (char === "(") markdownDestinationDepth += 1;

      if (char === ")") markdownDestinationDepth -= 1;

      return;
    }

    if (blockQuoteLine) {
      output += char;

      if (char === "\n" || char === "\r") {
        blockQuoteLine = false;
        atLineStart = true;
      }

      return;
    }

    if (asciiQuoteOpen || curlyQuoteOpen) {
      output += char;

      if (asciiQuoteOpen && char === '"') asciiQuoteOpen = false;

      if (curlyQuoteOpen && char === "”") curlyQuoteOpen = false;

      if (char === "\n" || char === "\r") atLineStart = true;

      return;
    }

    if (pendingHyphenBefore !== null) {
      if (char === "-") {
        if (pendingHyphenBefore.length === 0 && tokenNeedsExactPunctuation()) {
          output += "--";
          currentProseToken += "--";
          previousProseNonSpace = "-";
          pendingHyphenBefore = null;

          return;
        }

        pendingDash = { char: "--", before: pendingHyphenBefore };
        pendingHyphenBefore = null;

        return;
      }

      emitSingleHyphen();
    }

    if (char === "`") {
      tickBuffer += char;

      return;
    }

    resolveTicks();

    if (mode === "code") {
      output += char;

      return;
    }

    if (char === "(" && priorInputChar === "]") {
      emitProseChar(char);
      markdownDestinationDepth = 1;

      return;
    }

    if (atLineStart && char === ">") {
      resolveDash();
      emitWhitespace();
      output += char;
      previousProseNonSpace = char;
      blockQuoteLine = true;
      atLineStart = false;

      return;
    }

    const asciiQuoteStarts =
      char === '"' && (priorInputChar.length === 0 || /[\s([{<>=:;]/u.test(priorInputChar));

    if (asciiQuoteStarts || char === "“") {
      resolveDash();
      emitWhitespace();
      output += char;
      previousProseNonSpace = char;
      asciiQuoteOpen = char === '"';
      curlyQuoteOpen = char === "“";
      atLineStart = false;

      return;
    }

    if (atLineStart && char === "|" && !replayingPipeScan) {
      // Flush held whitespace first, so the buffered row stays in order.
      resolveDash();
      emitWhitespace();
      structuralPipeScan = char;

      return;
    }

    if (char === "-") {
      if (atLineStart && mode === "prose") {
        lineStartHyphens = "-";

        return;
      }

      pendingHyphenBefore = whitespace;
      whitespace = "";

      return;
    }

    emitProseChar(char);
  };

  return {
    push(raw: string): string {
      for (const char of raw) processChar(char);

      return takeOutput();
    },
    flush(): string {
      if (structuralPipeScan !== null) {
        // Ended mid-row. Emit the buffer as is.
        output += structuralPipeScan;
        structuralPipeScan = null;
      }

      resolveLineStartHyphensAsProse();
      resolveTicks();
      emitSingleHyphen();

      if (pendingDash) {
        // A trailing separator has nothing after it. Keep line breaks, drop the dash.
        const structural = `${pendingDash.before}${whitespace}`;

        if (hasLineBreak(structural)) output += withoutTrailingHorizontalSpace(structural);
        pendingDash = null;
        whitespace = "";
      } else {
        emitWhitespace();
      }

      const finalOutput = takeOutput();
      // A tool call starts a new segment, so an unclosed quote or fence does not leak past it.
      mode = "prose";
      codeDelimiterLength = 0;
      tickBuffer = "";
      previousProseNonSpace = "";
      asciiQuoteOpen = false;
      curlyQuoteOpen = false;
      atLineStart = true;
      blockQuoteLine = false;
      markdownDestinationDepth = 0;
      previousInputChar = "";
      currentProseToken = "";
      lineStartHyphens = "";
      structuralMarkdownLine = false;
      structuralPipeScan = null;
      replayingPipeScan = false;

      return finalOutput;
    },
  };
}

/** Replace prose dashes; leave code and quotes alone. */
export function sanitizeVoice(text: string): string {
  if (!text.includes("—") && !text.includes("–") && !text.includes("--")) return text;
  const sanitizer = createVoiceStreamSanitizer();

  return sanitizer.push(text) + sanitizer.flush();
}
