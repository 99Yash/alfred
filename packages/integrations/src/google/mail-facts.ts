import { getStringPath } from "@alfred/contracts";
import { extractAttachments, type GmailMessage } from "./gmail";

type MessagePart = NonNullable<GmailMessage["payload"]>;

export interface GmailHeaderLookup {
  /** Case-insensitive. Trimmed; `null` when absent or empty. */
  readonly get: (name: string) => string | null;
}

/**
 * A lookup over a raw `payload.headers` array. The first occurrence wins: Gmail puts the newest
 * hop first, so a repeated `Authentication-Results` resolves to Gmail's own verdict.
 */
export function gmailHeaderLookup(headers: unknown): GmailHeaderLookup {
  const out = new Map<string, string>();

  if (Array.isArray(headers)) {
    for (const h of headers) {
      const name = getStringPath(h, "name")?.trim().toLowerCase();
      const value = getStringPath(h, "value")?.trim();

      if (name && value && !out.has(name)) out.set(name, value);
    }
  }

  return { get: (name) => out.get(name.toLowerCase()) ?? null };
}

/** The headers a reader needs to judge who sent a mail, to whom, and whether it is real. */
const FACT_HEADERS = [
  "From",
  "Reply-To",
  "To",
  "Cc",
  "Delivered-To",
  "Return-Path",
  "Authentication-Results",
  "List-Id",
  "Precedence",
  "Auto-Submitted",
] as const;

const FACT_HEADER_BY_KEY = new Map<string, string>(FACT_HEADERS.map((n) => [n.toLowerCase(), n]));

/**
 * A sender's own "why you got this" header (`X-GitHub-Reason`, `X-LinkedIn-Class`). It passes as
 * stored, so the reader judges it like any other fact; no vendor rule reads it.
 */
const WHY_HEADER_RE = /-(?:reason|class)$/i;

/** Bounds a long To/Cc list or a multi-signature auth line; the facts stay small next to the body. */
const MAX_FACT_VALUE_CHARS = 600;

const MAX_ATTACHMENT_NAMES = 10;

/**
 * The facts of a stored Gmail message, as Gmail recorded them at arrival, for a model to judge.
 * Values are verbatim (bounded), never interpreted: signature and relay headers are left out
 * because `Authentication-Results` already carries their verdict, and `List-Unsubscribe` is
 * reduced to its presence because its value is only links.
 */
export function readMailFacts(message: GmailMessage) {
  const headers: Record<string, string> = {};
  let listUnsubscribe = false;

  for (const { name, value } of message.payload?.headers ?? []) {
    const key = name.trim().toLowerCase();
    const trimmed = value.trim();

    if (key === "list-unsubscribe") {
      listUnsubscribe ||= trimmed.length > 0;
      continue;
    }

    const label = FACT_HEADER_BY_KEY.get(key) ?? (WHY_HEADER_RE.test(key) ? name.trim() : null);

    if (!label || !trimmed || label in headers) continue;
    headers[label] =
      trimmed.length > MAX_FACT_VALUE_CHARS
        ? `${trimmed.slice(0, MAX_FACT_VALUE_CHARS)}…`
        : trimmed;
  }

  return {
    headers,
    listUnsubscribe,
    labelIds: message.labelIds ?? [],
    calendarInvite: hasCalendarPart(message.payload),
    attachments: extractAttachments(message)
      .slice(0, MAX_ATTACHMENT_NAMES)
      .map((a) => a.filename),
  };
}

export type MailFacts = ReturnType<typeof readMailFacts>;

/** An invite rides as a `text/calendar` part, often nested under `multipart/alternative`. */
function hasCalendarPart(part: MessagePart | undefined): boolean {
  if (!part) return false;
  const mimeType = part.mimeType?.toLowerCase();

  if (
    mimeType === "text/calendar" ||
    mimeType === "application/ics" ||
    part.filename?.toLowerCase().endsWith(".ics")
  ) {
    return true;
  }

  return (part.parts ?? []).some(hasCalendarPart);
}
