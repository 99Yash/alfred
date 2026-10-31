import { logger } from "@alfred/logging";
import { decodeHtmlEntities, toMessage } from "@alfred/contracts";
import { z } from "zod";
import type { RetryPolicy } from "../shared/retry";
import { uncheckedResponse } from "../shared/authed-json";
import { googleJson } from "./http";

/** Gmail REST client without `googleapis`. */

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
  partId?: string | undefined;
  mimeType?: string | undefined;
  filename?: string | undefined;
  headers?: { name: string; value: string }[] | undefined;
  body?:
    | { size?: number | undefined; data?: string | undefined; attachmentId?: string | undefined }
    | undefined;
  parts?: MessagePart[] | undefined;
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

/** A persisted `documents.raw` read back as a Gmail message, or `null` when it is not one. */
export function parseStoredGmailMessage(raw: unknown): GmailMessage | null {
  const parsed = messageSchema.safeParse(raw);

  return parsed.success ? parsed.data : null;
}

export interface ListMessagesArgs {
  accessToken: string;
  /** Gmail search query (`newer_than:30d`, `in:inbox`, etc.). */
  q?: string | undefined;
  /** Gmail max is 500. */
  maxResults?: number | undefined;
  pageToken?: string | undefined;
  /** Messages must carry all of these labels. */
  labelIds?: string[] | undefined;
}

export interface ListMessagesResult {
  messages: GmailMessageRef[];
  nextPageToken?: string | undefined;
}

export async function listMessages(
  args: ListMessagesArgs,
  retry: RetryPolicy | "none" = "none",
): Promise<ListMessagesResult> {
  const url = new URL(`${API_BASE}/messages`);
  url.searchParams.set("maxResults", String(args.maxResults ?? 100));

  if (args.q) url.searchParams.set("q", args.q);

  if (args.pageToken) url.searchParams.set("pageToken", args.pageToken);

  if (args.labelIds) for (const l of args.labelIds) url.searchParams.append("labelIds", l);

  const parsed = await googleJson("gmail", listMessagesResponseSchema, {
    url: url.toString(),
    accessToken: args.accessToken,
    retry,
  });

  return {
    messages: parsed.messages ?? [],
    nextPageToken: parsed.nextPageToken,
  };
}

export interface GetMessageArgs {
  accessToken: string;
  id: string;
  /** `full` includes body and MIME parts; `metadata` skips the body. */
  format?: "full" | "metadata" | "minimal" | "raw" | undefined;
}

export async function getMessage(
  args: GetMessageArgs,
  retry: RetryPolicy | "none" = "none",
): Promise<GmailMessage> {
  const url = new URL(`${API_BASE}/messages/${args.id}`);
  url.searchParams.set("format", args.format ?? "full");

  return googleJson("gmail", messageSchema, {
    url: url.toString(),
    accessToken: args.accessToken,
    retry,
  });
}

const threadMessageMinSchema = z.object({
  id: z.string(),
  labelIds: z.array(z.string()).optional(),
});

const threadGetMinResponseSchema = z.object({
  messages: z.array(threadMessageMinSchema).optional(),
});

export interface ThreadMessageLabels {
  id: string;
  labelIds: string[];
}

/** `minimal` format: ids and labels only, no body or headers. */
export async function getThreadMessageLabels(args: {
  accessToken: string;
  threadId: string;
}): Promise<ThreadMessageLabels[]> {
  const url = new URL(`${API_BASE}/threads/${args.threadId}`);
  url.searchParams.set("format", "minimal");

  const parsed = await googleJson("gmail", threadGetMinResponseSchema, {
    url: url.toString(),
    accessToken: args.accessToken,
  });

  return (parsed.messages ?? []).map((m) => ({
    id: m.id,
    labelIds: m.labelIds ?? [],
  }));
}

// users.history.list: delta sync from a baseline historyId

const historyMessageRefSchema = z.object({
  message: messageRefSchema.extend({
    labelIds: z.array(z.string()).optional(),
  }),
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
  /** The `historyId` from the last successful poll or watch. */
  startHistoryId: string;
  /** Default `["messageAdded"]`. */
  historyTypes?: ("messageAdded" | "messageDeleted" | "labelAdded" | "labelRemoved")[];
  pageToken?: string | undefined;
  maxResults?: number | undefined;
}

export interface ListHistoryResult {
  entries: GmailHistoryEntry[];
  nextPageToken?: string | undefined;
  /** Use this as the next cursor when there are no entries, or a quiet mailbox never advances. */
  historyId?: string | undefined;
}

/**
 * One page; callers paginate. A `startHistoryId` older than about 7 days gets a 404,
 * and the caller must fall back to a full re-ingest (ADR-0024).
 */
export async function listHistory(args: ListHistoryArgs): Promise<ListHistoryResult> {
  const url = new URL(`${API_BASE}/history`);
  url.searchParams.set("startHistoryId", args.startHistoryId);

  for (const t of args.historyTypes ?? ["messageAdded"]) {
    url.searchParams.append("historyTypes", t);
  }

  if (args.pageToken) url.searchParams.set("pageToken", args.pageToken);

  if (args.maxResults) url.searchParams.set("maxResults", String(args.maxResults));

  const parsed = await googleJson("gmail", historyListResponseSchema, {
    url: url.toString(),
    accessToken: args.accessToken,
  });

  return {
    entries: parsed.history ?? [],
    nextPageToken: parsed.nextPageToken,
    historyId: parsed.historyId,
  };
}

/** String match: brittle, but a false match only costs a full re-ingest. */
export function isHistoryGoneError(err: unknown): boolean {
  const msg = toMessage(err);

  return /\[gmail\] 404 /.test(msg) && /history/.test(msg);
}

// users.watch / users.stop: push through Cloud Pub/Sub

const watchResponseSchema = z.object({
  historyId: z.string(),
  /** Epoch ms as a string: Gmail sends int64 as a string. */
  expiration: z.string(),
});

export interface StartWatchArgs {
  accessToken: string;
  /** e.g. `projects/<id>/topics/gmail-push`. */
  topicName: string;
  /** Empty means all mail. */
  labelIds?: string[] | undefined;
  /** Default `include`. */
  labelFilterAction?: "include" | "exclude" | undefined;
}

export interface StartWatchResult {
  /** The baseline for the next `users.history.list`. */
  historyId: string;
  /** Gmail caps a channel at about 7 days. Renew before this. */
  expiration: Date;
}

export async function startWatch(args: StartWatchArgs): Promise<StartWatchResult> {
  const payload = {
    topicName: args.topicName,
    ...(args.labelIds?.length ? { labelIds: args.labelIds } : {}),
    ...(args.labelFilterAction ? { labelFilterAction: args.labelFilterAction } : {}),
  };

  const parsed = await googleJson("gmail", watchResponseSchema, {
    method: "POST",
    url: `${API_BASE}/watch`,
    accessToken: args.accessToken,
    payload,
  });

  return {
    historyId: parsed.historyId,
    expiration: new Date(Number(parsed.expiration)),
  };
}

export async function stopWatch(args: { accessToken: string }): Promise<void> {
  await googleJson("gmail", uncheckedResponse, {
    method: "POST",
    url: `${API_BASE}/stop`,
    accessToken: args.accessToken,
    payload: {},
  });
}

// users.labels and messages.modify

const labelSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(["system", "user"]).optional(),
  messageListVisibility: z.enum(["show", "hide"]).optional(),
  labelListVisibility: z.enum(["labelShow", "labelShowIfUnread", "labelHide"]).optional(),
});

export type GmailLabel = z.infer<typeof labelSchema>;

const listLabelsResponseSchema = z.object({
  labels: z.array(labelSchema).optional(),
});

export async function listLabels(args: { accessToken: string }): Promise<GmailLabel[]> {
  const parsed = await googleJson("gmail", listLabelsResponseSchema, {
    url: `${API_BASE}/labels`,
    accessToken: args.accessToken,
  });

  return parsed.labels ?? [];
}

export interface CreateLabelArgs {
  accessToken: string;
  /** A `/` makes a nested label. */
  name: string;
  messageListVisibility?: "show" | "hide" | undefined;
  labelListVisibility?: "labelShow" | "labelShowIfUnread" | "labelHide" | undefined;
}

export async function createLabel(args: CreateLabelArgs): Promise<GmailLabel> {
  const payload = {
    name: args.name,
    messageListVisibility: args.messageListVisibility ?? "show",
    labelListVisibility: args.labelListVisibility ?? "labelShow",
  };

  return googleJson("gmail", labelSchema, {
    method: "POST",
    url: `${API_BASE}/labels`,
    accessToken: args.accessToken,
    payload,
  });
}

export interface ModifyMessageLabelsArgs {
  accessToken: string;
  /** A message id, not a thread id. */
  messageId: string;
  addLabelIds?: string[] | undefined;
  removeLabelIds?: string[] | undefined;
}

/** Idempotent. Returns the new label set, so no extra get is needed. */
export async function modifyMessageLabels(args: ModifyMessageLabelsArgs): Promise<GmailMessage> {
  const payload = {
    ...(args.addLabelIds?.length ? { addLabelIds: args.addLabelIds } : {}),
    ...(args.removeLabelIds?.length ? { removeLabelIds: args.removeLabelIds } : {}),
  };

  return googleJson("gmail", messageSchema, {
    method: "POST",
    url: `${API_BASE}/messages/${args.messageId}/modify`,
    accessToken: args.accessToken,
    payload,
  });
}

export interface BatchModifyMessagesArgs {
  accessToken: string;
  /** Message ids, at most 1000. Empty throws: a no-op call is usually a bug. */
  messageIds: ReadonlyArray<string>;
  addLabelIds?: string[] | undefined;
  removeLabelIds?: string[] | undefined;
}

/** Idempotent per message. Gmail returns 204, so this returns nothing. */
export async function batchModifyMessages(args: BatchModifyMessagesArgs): Promise<void> {
  if (args.messageIds.length === 0) {
    throw new Error("[gmail] batchModifyMessages called with empty messageIds");
  }

  if (args.messageIds.length > 1000) {
    throw new Error(
      `[gmail] batchModifyMessages exceeds Gmail's 1000-id cap (got ${args.messageIds.length})`,
    );
  }

  const payload = {
    ids: args.messageIds,
    ...(args.addLabelIds?.length ? { addLabelIds: args.addLabelIds } : {}),
    ...(args.removeLabelIds?.length ? { removeLabelIds: args.removeLabelIds } : {}),
  };

  await googleJson("gmail", uncheckedResponse, {
    method: "POST",
    url: `${API_BASE}/messages/batchModify`,
    accessToken: args.accessToken,
    payload,
  });
}

// users.threads

const threadSchema = z.object({
  id: z.string(),
  messages: z.array(messageSchema).optional(),
});

export type GmailThread = z.infer<typeof threadSchema>;

export interface GetThreadArgs {
  accessToken: string;
  threadId: string;
  /** `full` includes bodies; `metadata` stops at headers and labels. */
  format?: "full" | "metadata" | "minimal" | undefined;
}

export async function getThread(
  args: GetThreadArgs,
  retry: RetryPolicy | "none" = "none",
): Promise<GmailThread> {
  const url = new URL(`${API_BASE}/threads/${encodeURIComponent(args.threadId)}`);
  url.searchParams.set("format", args.format ?? "full");

  return googleJson("gmail", threadSchema, {
    url: url.toString(),
    accessToken: args.accessToken,
    retry,
  });
}

export interface ModifyThreadLabelsArgs {
  accessToken: string;
  threadId: string;
  /** Label ids, at most 100. `TRASH` and `SPAM` are label ids here too. */
  addLabelIds?: string[] | undefined;
  removeLabelIds?: string[] | undefined;
}

/** Changes the labels of every message in the thread. Idempotent. Needs `gmail.modify`. */
export async function modifyThreadLabels(args: ModifyThreadLabelsArgs): Promise<GmailThread> {
  const payload = {
    ...(args.addLabelIds?.length ? { addLabelIds: args.addLabelIds } : {}),
    ...(args.removeLabelIds?.length ? { removeLabelIds: args.removeLabelIds } : {}),
  };

  return googleJson("gmail", threadSchema, {
    method: "POST",
    url: `${API_BASE}/threads/${encodeURIComponent(args.threadId)}/modify`,
    accessToken: args.accessToken,
    payload,
  });
}

export interface DraftMessageArgs {
  accessToken: string;
  to: string[];
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
  subject: string;
  /** Sent as `text/plain`. */
  bodyText: string;
  /** Groups the reply into the thread. Full threading also needs `In-Reply-To`, not sent yet. */
  threadId?: string | undefined;
}

export interface SentMessage {
  id: string;
  threadId: string;
}

/** RFC 2047-encode non-ASCII values so accents and emoji do not corrupt the MIME. */
function encodeHeaderValue(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII range test
  // oxlint-disable-next-line no-control-regex -- ASCII range test, not a control-char match
  if (/^[\x00-\x7F]*$/.test(value)) return value;

  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function assertHeaderSafe(name: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`[gmail] ${name} header contains forbidden line breaks`);
  }
}

/** The Gmail `message` body for a plain-text mail: base64url MIME plus the optional thread. */
function plainTextMessage(args: Omit<DraftMessageArgs, "accessToken">) {
  for (const value of [...args.to, ...(args.cc ?? []), ...(args.bcc ?? [])]) {
    assertHeaderSafe("recipient", value);
  }

  assertHeaderSafe("subject", args.subject);

  const headers = [`To: ${args.to.join(", ")}`];

  if (args.cc?.length) headers.push(`Cc: ${args.cc.join(", ")}`);

  if (args.bcc?.length) headers.push(`Bcc: ${args.bcc.join(", ")}`);
  headers.push(`Subject: ${encodeHeaderValue(args.subject)}`);
  headers.push("MIME-Version: 1.0");
  headers.push('Content-Type: text/plain; charset="UTF-8"');
  headers.push("Content-Transfer-Encoding: 8bit");

  const mime = `${headers.join("\r\n")}\r\n\r\n${args.bodyText}`;

  return {
    raw: Buffer.from(mime, "utf8").toString("base64url"),
    ...(args.threadId ? { threadId: args.threadId } : {}),
  };
}

// users.drafts

const draftResponseSchema = z.object({
  id: z.string(),
  message: messageRefSchema,
});

export interface CreateDraftResult {
  draftId: string;
  messageId: string;
  threadId: string;
}

/**
 * Saves a plain-text draft and sends nothing. Needs `gmail.modify` or `gmail.compose`. Not
 * idempotent: a second call saves a second draft.
 */
export async function createDraft(args: DraftMessageArgs): Promise<CreateDraftResult> {
  const { accessToken, ...message } = args;

  const parsed = await googleJson("gmail", draftResponseSchema, {
    method: "POST",
    url: `${API_BASE}/drafts`,
    accessToken,
    payload: { message: plainTextMessage(message) },
  });

  return { draftId: parsed.id, messageId: parsed.message.id, threadId: parsed.message.threadId };
}

export interface DraftRefArgs {
  accessToken: string;
  draftId: string;
}

/**
 * Sends a saved draft. Needs `gmail.modify` or `gmail.compose`; `gmail.send` is not enough. A draft
 * sends once: Gmail deletes it on send, so a second call with the same id gets 404 and sends
 * nothing. The sent message has a new id, in the draft's thread.
 */
export async function sendDraft(args: DraftRefArgs): Promise<SentMessage> {
  const parsed = await googleJson("gmail", messageSchema, {
    method: "POST",
    url: `${API_BASE}/drafts/send`,
    accessToken: args.accessToken,
    payload: { id: args.draftId },
  });

  return { id: parsed.id, threadId: parsed.threadId };
}

/** Deletes a draft for good, not to the trash. Needs `gmail.modify` or `gmail.compose`. */
export async function deleteDraft(args: DraftRefArgs): Promise<void> {
  await googleJson("gmail", uncheckedResponse, {
    method: "DELETE",
    url: `${API_BASE}/drafts/${encodeURIComponent(args.draftId)}`,
    accessToken: args.accessToken,
  });
}

// MIME helpers

export interface ExtractedMessage {
  subject: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  bcc: string | null;
  date: Date | null;
  /** Plain text, else stripped HTML, else the snippet. */
  body: string;
  /** Keys are lowercased. */
  headers: ReadonlyMap<string, string>;
}

export function extractMessageContent(message: GmailMessage): ExtractedMessage {
  const headers = headersToMap(message.payload?.headers ?? []);
  const text = collectText(message.payload, "text/plain");
  let body = text;

  if (!body) {
    const html = collectText(message.payload, "text/html");

    if (html) body = stripHtml(html);
  }

  if (!body) body = message.snippet ?? "";

  const dateHeader = headers.get("date");
  const dateValue = dateHeader ? new Date(dateHeader) : null;

  return {
    subject: headers.get("subject") ?? null,
    from: headers.get("from") ?? null,
    to: headers.get("to") ?? null,
    cc: headers.get("cc") ?? null,
    bcc: headers.get("bcc") ?? null,
    date: dateValue && !isNaN(dateValue.getTime()) ? dateValue : null,
    body,
    headers,
  };
}

export interface ExtractedAttachment {
  /** e.g. `"1.2"`. Null for a malformed part. */
  partId: string | null;
  /** Token for `messages.attachments.get`. */
  attachmentId: string;
  filename: string;
  mimeType: string;
  /** Bytes as Gmail reports them. `0` when missing. */
  size: number;
}

/**
 * A real attachment has a filename and an `attachmentId`. Inline images usually have
 * no filename, so they are skipped.
 */
export function extractAttachments(message: GmailMessage): ExtractedAttachment[] {
  const out: ExtractedAttachment[] = [];
  walkAttachments(message.payload, out);

  return out;
}

function walkAttachments(part: MessagePart | undefined, out: ExtractedAttachment[]): void {
  if (!part) return;
  const filename = part.filename?.trim();
  const attachmentId = part.body?.attachmentId;

  if (filename && attachmentId) {
    out.push({
      partId: part.partId ?? null,
      attachmentId,
      filename,
      mimeType: part.mimeType ?? "application/octet-stream",
      size: part.body?.size ?? 0,
    });
  }

  for (const sub of part.parts ?? []) walkAttachments(sub, out);
}

const getAttachmentResponseSchema = z.object({
  size: z.number().optional(),
  data: z.string().optional(),
});

export interface GetAttachmentArgs {
  accessToken: string;
  messageId: string;
  attachmentId: string;
}

export interface GetAttachmentResult {
  size: number;
  bytes: Uint8Array;
}

export async function getAttachment(
  args: GetAttachmentArgs,
  retry: RetryPolicy | "none" = "none",
): Promise<GetAttachmentResult> {
  const url = `${API_BASE}/messages/${encodeURIComponent(args.messageId)}/attachments/${encodeURIComponent(args.attachmentId)}`;

  const parsed = await googleJson("gmail", getAttachmentResponseSchema, {
    url,
    accessToken: args.accessToken,
    retry,
  });

  const dataBase64Url = parsed.data ?? "";
  // Node's base64 decoder accepts the URL-safe alphabet and missing padding.
  const bytes = dataBase64Url ? Buffer.from(dataBase64Url, "base64") : Buffer.alloc(0);

  if (parsed.size !== undefined && parsed.size !== bytes.byteLength) {
    logger.warn(
      `[gmail] attachment size mismatch for message=${args.messageId} ` +
        `attachment=${args.attachmentId}: reported=${parsed.size} decoded=${bytes.byteLength}`,
    );
  }

  return {
    size: parsed.size ?? bytes.byteLength,
    bytes: new Uint8Array(bytes),
  };
}

/** For the sandboxed iframe view. `body` stays the text fallback. */
export function extractMessageHtml(message: GmailMessage): string | null {
  const html = collectText(message.payload, "text/html");

  return html || null;
}

function headersToMap(headers: { name: string; value: string }[]): Map<string, string> {
  const out = new Map<string, string>();

  for (const h of headers) out.set(h.name.toLowerCase(), h.value);

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

/** Naive tag strip. Good enough for ingestion. */
function stripHtml(html: string): string {
  const text = html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "");

  return decodeHtmlEntities(text)
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
