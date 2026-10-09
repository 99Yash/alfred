/**
 * A quoted reply is a Markdown blockquote ahead of the message, so the model reads it as cited text
 * and the user bubble can show it apart from the question. Both directions live here.
 */

/** Longer selections are cut, so one drag across a long reply does not flood the turn. */
const MAX_QUOTE_CHARS = 2_000;

/** `> quote` lines, a blank line, then the message. */
export function quoteMessage(quote: string, text: string): string {
  const clean = quote.trim().replace(/\n{3,}/g, "\n\n");

  const cut =
    clean.length > MAX_QUOTE_CHARS ? `${clean.slice(0, MAX_QUOTE_CHARS).trimEnd()}…` : clean;

  const lines = cut.split("\n").map((line) => (line.trim() ? `> ${line}` : ">"));

  return `${lines.join("\n")}\n\n${text}`;
}

/** A user message split into its leading quote, if any, and the rest. */
export interface QuotedMessage {
  quote: string | null;
  body: string;
}

/** The number of leading `>` lines. */
function quoteLineCount(lines: readonly string[]): number {
  let end = 0;

  while (end < lines.length && lines[end]?.startsWith(">")) end += 1;

  return end;
}

/** The inverse of {@link quoteMessage}. */
export function splitQuote(content: string): QuotedMessage {
  const lines = content.split("\n");
  const end = quoteLineCount(lines);

  // A quote with no message after it is the message itself.
  const body = lines.slice(end).join("\n").trim();

  if (end === 0 || !body) return { quote: null, body: content };

  const quote = lines
    .slice(0, end)
    .map((line) => line.replace(/^> ?/, ""))
    .join("\n")
    .trim();

  return quote ? { quote, body } : { quote: null, body: content };
}

/** `content` with a new message. The quote lines stay byte for byte, so an edit cannot cut them twice. */
export function replaceQuotedBody(content: string, body: string): string {
  if (!splitQuote(content).quote) return body;
  const lines = content.split("\n");

  return `${lines.slice(0, quoteLineCount(lines)).join("\n")}\n\n${body}`;
}
