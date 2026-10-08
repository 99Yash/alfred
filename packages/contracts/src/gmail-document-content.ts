export interface GmailDocumentEnvelope {
  from?: string | null | undefined;
  to?: string | null | undefined;
  cc?: string | null | undefined;
  subject?: string | null | undefined;
}

export interface BuildGmailDocumentContentArgs extends GmailDocumentEnvelope {
  body: string;
  date?: Date | null | undefined;
}

const STORED_DATE_LINE_RE = /^Date: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/**
 * The only writer of the Gmail `documents.content` string. Read it back with
 * `extractGmailDocumentBody`: a real body can itself start with `From:`.
 */
export function buildGmailDocumentContent(args: BuildGmailDocumentContentArgs): string {
  const headerLines = expectedEnvelopeLines(args);

  if (args.date) headerLines.push(`Date: ${args.date.toISOString()}`);
  const header = headerLines.join("\n");

  return header ? `${header}\n\n${args.body}` : args.body;
}

/**
 * Strip the header only when it exactly matches two or more envelope fields, plus an
 * optional date. Otherwise return the content as is: a duplicate header beats a lost body.
 */
export function extractGmailDocumentBody(
  content: string | null | undefined,
  envelope: GmailDocumentEnvelope,
): string {
  const value = content ?? "";
  const separator = value.indexOf("\n\n");

  if (separator < 0) return value;

  const expected = expectedEnvelopeLines(envelope);

  if (expected.length < 2) return value;

  const actual = value.slice(0, separator).split("\n");
  const hasStoredDate = actual.length === expected.length + 1;

  if (actual.length !== expected.length && !hasStoredDate) return value;

  if (!expected.every((line, index) => actual[index] === line)) return value;

  if (hasStoredDate && !STORED_DATE_LINE_RE.test(actual.at(-1) ?? "")) return value;

  return value.slice(separator + 2);
}

function expectedEnvelopeLines(envelope: GmailDocumentEnvelope): string[] {
  const lines: string[] = [];

  if (envelope.from) lines.push(`From: ${envelope.from}`);

  if (envelope.to) lines.push(`To: ${envelope.to}`);

  if (envelope.cc) lines.push(`Cc: ${envelope.cc}`);

  if (envelope.subject) lines.push(`Subject: ${envelope.subject}`);

  return lines;
}
