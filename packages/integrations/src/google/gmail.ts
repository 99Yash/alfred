import { z } from "zod";

/**
 * Thin Gmail REST client. We deliberately avoid `googleapis` (~2MB,
 * pulls in all Google APIs) and call the JSON endpoints directly. Only
 * the surface m7a needs is implemented; m7c will add `users.history.list`
 * for delta sync and the send endpoint.
 */

const API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

const messageRefSchema = z.object({
  id: z.string(),
  threadId: z.string(),
});

const listMessagesResponseSchema = z.object({
  messages: z.array(messageRefSchema).optional(),
  nextPageToken: z.string().optional(),
  resultSizeEstimate: z.number().optional(),
});
export type GmailMessageRef = z.infer<typeof messageRefSchema>;

const headerSchema = z.object({ name: z.string(), value: z.string() });

const messagePartSchema: z.ZodType<MessagePart> = z.lazy(() =>
  z.object({
    partId: z.string().optional(),
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    headers: z.array(headerSchema).optional(),
    body: z
      .object({
        size: z.number().optional(),
        data: z.string().optional(),
        attachmentId: z.string().optional(),
      })
      .optional(),
    parts: z.array(messagePartSchema).optional(),
  }),
);

interface MessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: MessagePart[];
}

const messageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).optional(),
  snippet: z.string().optional(),
  historyId: z.string().optional(),
  internalDate: z.string().optional(),
  payload: messagePartSchema.optional(),
  sizeEstimate: z.number().optional(),
});
export type GmailMessage = z.infer<typeof messageSchema>;

export interface ListMessagesArgs {
  accessToken: string;
  /** Gmail search query (`newer_than:30d`, `in:inbox`, etc.). */
  q?: string;
  /** Server-side cap; Gmail max is 500. */
  maxResults?: number;
  pageToken?: string;
  /** When set, restricts to messages with all of these label IDs. */
  labelIds?: string[];
}

export interface ListMessagesResult {
  messages: GmailMessageRef[];
  nextPageToken?: string;
}

export async function listMessages(args: ListMessagesArgs): Promise<ListMessagesResult> {
  const url = new URL(`${API_BASE}/messages`);
  url.searchParams.set("maxResults", String(args.maxResults ?? 100));
  if (args.q) url.searchParams.set("q", args.q);
  if (args.pageToken) url.searchParams.set("pageToken", args.pageToken);
  if (args.labelIds) for (const l of args.labelIds) url.searchParams.append("labelIds", l);

  const json = await getJson(url.toString(), args.accessToken);
  const parsed = listMessagesResponseSchema.parse(json);
  return {
    messages: parsed.messages ?? [],
    nextPageToken: parsed.nextPageToken,
  };
}

export interface GetMessageArgs {
  accessToken: string;
  id: string;
  /**
   * `full` returns headers + body + MIME parts (what we want for ingest).
   * `metadata` skips the body entirely (used by delta polling later).
   */
  format?: "full" | "metadata" | "minimal" | "raw";
}

export async function getMessage(args: GetMessageArgs): Promise<GmailMessage> {
  const url = new URL(`${API_BASE}/messages/${args.id}`);
  url.searchParams.set("format", args.format ?? "full");
  const json = await getJson(url.toString(), args.accessToken);
  return messageSchema.parse(json);
}

async function getJson(url: string, accessToken: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`[gmail] ${res.status} ${url} :: ${body.slice(0, 500)}`);
  }
  return await res.json();
}

// ---------------------------------------------------------------------------
// MIME helpers
// ---------------------------------------------------------------------------

export interface ExtractedMessage {
  subject: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  bcc: string | null;
  date: Date | null;
  /** Best-effort plain-text body. Falls back to the snippet if we can't find one. */
  body: string;
  /** Headers as a flat record for downstream metadata queries. */
  headers: Record<string, string>;
}

/**
 * Walk the MIME tree to extract the user-facing email content. Gmail
 * messages can be a single part (`text/plain`) or multipart with HTML
 * + text alternatives plus attachments. Strategy:
 *   1. Prefer `text/plain` parts.
 *   2. Fall back to `text/html` stripped of tags.
 *   3. Fall back to the snippet.
 *
 * Attachments are skipped entirely in m7a — we'll surface them in m7b
 * when ingestion gets a richer object model.
 */
export function extractMessageContent(message: GmailMessage): ExtractedMessage {
  const headers = headersToRecord(message.payload?.headers ?? []);
  const text = collectText(message.payload, "text/plain");
  let body = text;
  if (!body) {
    const html = collectText(message.payload, "text/html");
    if (html) body = stripHtml(html);
  }
  if (!body) body = message.snippet ?? "";

  const dateHeader = headers["date"] ?? headers["Date"];
  const dateValue = dateHeader ? new Date(dateHeader) : null;

  return {
    subject: headers["subject"] ?? headers["Subject"] ?? null,
    from: headers["from"] ?? headers["From"] ?? null,
    to: headers["to"] ?? headers["To"] ?? null,
    cc: headers["cc"] ?? headers["Cc"] ?? null,
    bcc: headers["bcc"] ?? headers["Bcc"] ?? null,
    date: dateValue && !isNaN(dateValue.getTime()) ? dateValue : null,
    body,
    headers,
  };
}

function headersToRecord(headers: { name: string; value: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) out[h.name.toLowerCase()] = h.value;
  return out;
}

function collectText(part: MessagePart | undefined, mimeType: string): string {
  if (!part) return "";
  if (part.mimeType === mimeType && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  if (part.parts) {
    for (const sub of part.parts) {
      const text = collectText(sub, mimeType);
      if (text) return text;
    }
  }
  return "";
}

function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

/** Naive HTML strip — preserves text content, drops tags. Sufficient for ingestion. */
function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
