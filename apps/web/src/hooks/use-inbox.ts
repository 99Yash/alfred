import { useQuery } from "@tanstack/react-query";
import { client } from "~/lib/eden";
import type { InboxItem, ToolTone } from "~/routes/-preview-chat/helpers";

/**
 * Recent Gmail threads for the rail's Inbox tab. Returns the rail's local
 * `InboxItem` shape so `InboxFeed` stays presentation-only — the network
 * envelope is collapsed into the view model here, not at the call site.
 *
 * The endpoint is best-effort: a 401 (Gmail not connected) and an empty
 * 200 both surface as `items = []`, which `InboxFeed` renders as the
 * "Connect Gmail to see your latest unread threads here" empty state.
 */
export function useInbox() {
  return useQuery<ReadonlyArray<InboxItem>>({
    queryKey: ["me", "inbox"],
    queryFn: async () => {
      const res = await client.api.me.inbox.get();
      if (res.error || !res.data) return [];
      return res.data.items.map(toInboxItem);
    },
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

interface InboxResponseItem {
  documentId: string;
  sender: string | null;
  subject: string | null;
  snippet: string | null;
  authoredAt: string | null;
  unread: boolean;
  category: string | null;
}

function toInboxItem(row: InboxResponseItem): InboxItem {
  const display = senderDisplay(row.sender);
  return {
    id: row.documentId,
    sender: display || "Unknown sender",
    subject: row.subject ?? "(no subject)",
    preview: cleanPreview(row.snippet) || " ",
    time: formatRelative(row.authoredAt),
    unread: row.unread,
    initial: initialFor(display),
    tone: toneFor(display),
  };
}

/**
 * Pull a display name out of a raw RFC 5322 `From` header. Common shapes:
 *   `"Maya Chen" <maya@example.com>` → `Maya Chen`
 *   `Maya Chen <maya@example.com>`   → `Maya Chen`
 *   `maya@example.com`               → `maya`
 *   `Linear <notifications@linear.app>` → `Linear`
 */
function senderDisplay(raw: string | null): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  // Strip the angle-bracketed address; what remains is the display name.
  const beforeBracket = trimmed.split("<")[0]?.trim() ?? "";
  const unquoted = beforeBracket.replace(/^"|"$/g, "").trim();
  if (unquoted) return unquoted;
  // No display name → fall back to the local part of the email.
  const addr = trimmed.match(/<([^>]+)>/)?.[1] ?? trimmed;
  return addr.split("@")[0] ?? trimmed;
}

function initialFor(name: string): string {
  if (!name) return "?";
  const first = name.trim().charAt(0).toUpperCase();
  return first || "?";
}

const TONE_PALETTE: ReadonlyArray<ToolTone> = [
  "purple",
  "sky",
  "amber",
  "green",
  "pink",
  "orange",
];

/**
 * Deterministic tone-per-sender so the same correspondent keeps the same
 * avatar color across renders. Cheap djb2 hash on the display name.
 */
function toneFor(name: string): ToolTone {
  if (!name) return "purple";
  let hash = 5381;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) + hash + name.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % TONE_PALETTE.length;
  return TONE_PALETTE[idx] ?? "purple";
}

/**
 * Gmail snippets ship with HTML entities and stray whitespace. Decode the
 * common ones inline — pulling in a full entity library for three glyphs
 * isn't worth the bundle cost.
 */
function cleanPreview(snippet: string | null): string {
  if (!snippet) return "";
  return snippet
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function formatRelative(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const delta = Date.now() - t;
  if (delta < MINUTE) return "now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;
  const days = Math.floor(delta / DAY);
  if (days < 7) return `${days}d`;
  // Older than a week — fall back to a short date so the rail isn't a wall
  // of identical "12d" / "47d" rows.
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
