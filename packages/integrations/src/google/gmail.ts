import { z } from "zod";

/**
 * Thin Gmail REST client. We deliberately avoid `googleapis` (~2MB,
 * pulls in all Google APIs) and call the JSON endpoints directly. The
 * surface implemented here covers the m7a→m7c slice: list/get for
 * ingestion, history.list for delta sync, watch/stop for push channels.
 * Send + label-modify wait for m9.
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

async function postJson(url: string, accessToken: string, payload: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload ?? {}),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`[gmail] POST ${res.status} ${url} :: ${body.slice(0, 500)}`);
  }
  // 204 No Content from /stop has an empty body.
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

// ---------------------------------------------------------------------------
// users.history.list — delta sync from a baseline historyId
// ---------------------------------------------------------------------------

const historyMessageRefSchema = z.object({
  message: messageRefSchema.extend({ labelIds: z.array(z.string()).optional() }),
});

const historyLabelChangeSchema = z.object({
  message: messageRefSchema,
  labelIds: z.array(z.string()).optional(),
});

const historyEntrySchema = z.object({
  id: z.string(),
  messages: z.array(messageRefSchema).optional(),
  messagesAdded: z.array(historyMessageRefSchema).optional(),
  messagesDeleted: z.array(historyMessageRefSchema).optional(),
  labelsAdded: z.array(historyLabelChangeSchema).optional(),
  labelsRemoved: z.array(historyLabelChangeSchema).optional(),
});

const historyListResponseSchema = z.object({
  history: z.array(historyEntrySchema).optional(),
  nextPageToken: z.string().optional(),
  historyId: z.string().optional(),
});

export type GmailHistoryEntry = z.infer<typeof historyEntrySchema>;

export interface ListHistoryArgs {
  accessToken: string;
  /** Baseline cursor — the `historyId` returned by the previous successful poll/watch. */
  startHistoryId: string;
  /** Defaults to ["messageAdded"] — narrows the response and matches our ingest semantics. */
  historyTypes?: ("messageAdded" | "messageDeleted" | "labelAdded" | "labelRemoved")[];
  pageToken?: string;
  maxResults?: number;
}

export interface ListHistoryResult {
  /** Raw history entries returned by Gmail. May be empty when nothing changed. */
  entries: GmailHistoryEntry[];
  nextPageToken?: string;
  /**
   * Latest mailbox historyId Gmail saw at the time of this call. Use this
   * (not the per-entry id) as the next cursor when there are no entries —
   * otherwise we'd never advance during quiet periods.
   */
  historyId?: string;
}

/**
 * Fan-out from a baseline `historyId`. One page; callers paginate.
 *
 * Important: Gmail returns 404 with `failedPrecondition` when
 * `startHistoryId` is older than ~7 days; the caller should detect that
 * and fall back to a full re-ingest (ADR-0024).
 */
export async function listHistory(args: ListHistoryArgs): Promise<ListHistoryResult> {
  const url = new URL(`${API_BASE}/history`);
  url.searchParams.set("startHistoryId", args.startHistoryId);
  for (const t of args.historyTypes ?? ["messageAdded"]) {
    url.searchParams.append("historyTypes", t);
  }
  if (args.pageToken) url.searchParams.set("pageToken", args.pageToken);
  if (args.maxResults) url.searchParams.set("maxResults", String(args.maxResults));
  const json = await getJson(url.toString(), args.accessToken);
  const parsed = historyListResponseSchema.parse(json);
  return {
    entries: parsed.history ?? [],
    nextPageToken: parsed.nextPageToken,
    historyId: parsed.historyId,
  };
}

/**
 * Detect the "history cursor too old" 404. Gmail responses look like
 * `{"error":{"code":404,"status":"NOT_FOUND",...}}` and our `getJson`
 * surfaces the status in the thrown message — string match is brittle
 * but cheap, and a wrong-classify here just triggers a full re-ingest.
 */
export function isHistoryGoneError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\[gmail\] 404 /.test(msg) && /history/.test(msg);
}

// ---------------------------------------------------------------------------
// users.watch / users.stop — push notifications via Cloud Pub/Sub
// ---------------------------------------------------------------------------

const watchResponseSchema = z.object({
  historyId: z.string(),
  /** ms-since-epoch as a string — Gmail returns int64 fields stringified. */
  expiration: z.string(),
});

export interface StartWatchArgs {
  accessToken: string;
  /** Fully-qualified Pub/Sub topic, e.g. `projects/<id>/topics/gmail-push`. */
  topicName: string;
  /** Restrict to specific labels (e.g. `["INBOX"]`) — empty/undefined = all mail. */
  labelIds?: string[];
  /** `include` (default) or `exclude` for the labelIds filter. */
  labelFilterAction?: "include" | "exclude";
}

export interface StartWatchResult {
  /** Use this as the baseline for the next users.history.list call. */
  historyId: string;
  /** Channel expiry — Gmail caps at ~7 days; renew before this. */
  expiration: Date;
}

export async function startWatch(args: StartWatchArgs): Promise<StartWatchResult> {
  const payload: Record<string, unknown> = { topicName: args.topicName };
  if (args.labelIds && args.labelIds.length) payload.labelIds = args.labelIds;
  if (args.labelFilterAction) payload.labelFilterAction = args.labelFilterAction;
  const json = await postJson(`${API_BASE}/watch`, args.accessToken, payload);
  const parsed = watchResponseSchema.parse(json);
  return {
    historyId: parsed.historyId,
    expiration: new Date(Number(parsed.expiration)),
  };
}

export async function stopWatch(args: { accessToken: string }): Promise<void> {
  await postJson(`${API_BASE}/stop`, args.accessToken, {});
}

// ---------------------------------------------------------------------------
// users.labels — list / create / messages.modify
// ---------------------------------------------------------------------------

const labelSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["system", "user"]).optional(),
  messageListVisibility: z.enum(["show", "hide"]).optional(),
  labelListVisibility: z
    .enum(["labelShow", "labelShowIfUnread", "labelHide"])
    .optional(),
});
export type GmailLabel = z.infer<typeof labelSchema>;

const listLabelsResponseSchema = z.object({
  labels: z.array(labelSchema).optional(),
});

export async function listLabels(args: { accessToken: string }): Promise<GmailLabel[]> {
  const json = await getJson(`${API_BASE}/labels`, args.accessToken);
  return listLabelsResponseSchema.parse(json).labels ?? [];
}

export interface CreateLabelArgs {
  accessToken: string;
  /** e.g. `Alfred/ActionNeeded` — `/` produces a nested label in the Gmail UI. */
  name: string;
  /** `show` (default) keeps the label rendered next to the message subject. */
  messageListVisibility?: "show" | "hide";
  /** `labelShow` (default) keeps the label visible in the sidebar. */
  labelListVisibility?: "labelShow" | "labelShowIfUnread" | "labelHide";
}

export async function createLabel(args: CreateLabelArgs): Promise<GmailLabel> {
  const payload: Record<string, unknown> = {
    name: args.name,
    messageListVisibility: args.messageListVisibility ?? "show",
    labelListVisibility: args.labelListVisibility ?? "labelShow",
  };
  const json = await postJson(`${API_BASE}/labels`, args.accessToken, payload);
  return labelSchema.parse(json);
}

export interface ModifyMessageLabelsArgs {
  accessToken: string;
  /** Gmail message id (NOT thread id). */
  messageId: string;
  addLabelIds?: string[];
  removeLabelIds?: string[];
}

/**
 * Apply / remove labels on a single message in one round-trip. Gmail's
 * `messages.modify` is idempotent — adding a label that's already on the
 * message is a no-op, and the same goes for removing one that isn't.
 *
 * Returns the message metadata (id + labelIds) so callers can verify the
 * post-modify label set without an extra get call.
 */
export async function modifyMessageLabels(
  args: ModifyMessageLabelsArgs,
): Promise<GmailMessage> {
  const payload: Record<string, unknown> = {};
  if (args.addLabelIds?.length) payload.addLabelIds = args.addLabelIds;
  if (args.removeLabelIds?.length) payload.removeLabelIds = args.removeLabelIds;
  const json = await postJson(
    `${API_BASE}/messages/${args.messageId}/modify`,
    args.accessToken,
    payload,
  );
  return messageSchema.parse(json);
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

  // `headersToRecord` lowercases all keys so we can do single lookups
  // here without juggling the (legal) header-name casing variations.
  const dateHeader = headers["date"];
  const dateValue = dateHeader ? new Date(dateHeader) : null;

  return {
    subject: headers["subject"] ?? null,
    from: headers["from"] ?? null,
    to: headers["to"] ?? null,
    cc: headers["cc"] ?? null,
    bcc: headers["bcc"] ?? null,
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
