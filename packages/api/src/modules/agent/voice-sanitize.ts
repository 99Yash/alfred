/**
 * Narrow deterministic enforcement for Alfred's no-dash preference.
 *
 * The transformer is deliberately lexical rather than regex-only. It preserves
 * fenced/inline code and quoted material, converts en-dash ranges to ASCII
 * hyphens, and keeps enough state for streamed output to behave exactly like a
 * completed string regardless of provider chunk boundaries.
 */

export interface VoiceStreamSanitizer {
  /** Feed a raw text delta; returns sanitized text that is safe to emit now. */
  push(raw: string): string;
  /** End the segment/stream, returning any held-back punctuation or whitespace. */
  flush(): string;
}

interface PendingDash {
  char: "—" | "–" | "--";
  /** Whitespace seen immediately before the dash. */
  before: string;
}

function withoutTrailingHorizontalSpace(value: string): string {
  return value.replace(/[ \t]+$/g, "");
}

function hasLineBreak(value: string): boolean {
  return value.includes("\n") || value.includes("\r");
}

/**
 * Create a chunk-invariant sanitizer. Markdown delimiters, prose whitespace,
 * and a pending dash may all straddle provider deltas, so each is carried as
 * explicit state instead of re-running a whole-string regexp on every chunk.
 */
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

  const resolveDash = (): void => {
    if (!pendingDash) return;
    const before = pendingDash.before;
    const after = whitespace;
    if (pendingDash.char === "–") {
      // An en dash is ambiguous between a range and a clause separator. ASCII
      // hyphenation preserves both meanings without guessing from neighboring
      // letters ("deploy – failed" is not a range) or joining words together.
      output += `${before}-${after}`;
    } else {
      // Preserve structural line breaks. On one line, a semicolon is safer than
      // manufacturing a comma splice between clauses.
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
      // Treat an adjacent dash run as one separator.
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

    if (char === "-") {
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
      resolveTicks();
      emitSingleHyphen();
      if (pendingDash) {
        // A reply that ends on a separator has no right-hand clause. Preserve
        // line structure but drop the stranded punctuation and horizontal space.
        const structural = `${pendingDash.before}${whitespace}`;
        if (hasLineBreak(structural)) output += withoutTrailingHorizontalSpace(structural);
        pendingDash = null;
        whitespace = "";
      } else {
        emitWhitespace();
      }
      const finalOutput = takeOutput();
      // A tool-call boundary starts a new prose segment. Do not let an unmatched
      // quote/fence in narration leak lexical state into the post-tool answer.
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
      return finalOutput;
    },
  };
}

/** Replace prose dashes while preserving code, quotes, and range meaning. */
export function sanitizeVoice(text: string): string {
  if (!text.includes("—") && !text.includes("–") && !text.includes("--")) return text;
  const sanitizer = createVoiceStreamSanitizer();
  return sanitizer.push(text) + sanitizer.flush();
}
