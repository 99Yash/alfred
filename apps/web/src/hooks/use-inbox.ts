import { isTriageCategory, type TriageCategory } from "@alfred/contracts";
import { useQuery } from "@tanstack/react-query";
import { client } from "~/lib/eden";
import type { IntegrationBrand } from "~/lib/integration-icons";
import type { InboxItem, ToolTone } from "~/routes/-preview-chat/helpers";

/**
 * Recent Gmail threads for the rail's Inbox tab. Returns the rail's local
 * `InboxItem` shape so `InboxFeed` stays presentation-only — the network
 * envelope is collapsed into the view model here, not at the call site.
 *
 * The endpoint is best-effort: a 401 (Gmail not connected) and an empty
 * 200 both surface as `items = []`, which `InboxFeed` renders as the
 * "Connect Gmail to see your latest unread threads here" empty state.
 *
 * Refresh: SSE `inbox.updated` frames invalidate this query in real time
 * (wired in `useEventBridge`), so the explicit poll is a slow backstop
 * for dropped frames + a fresh window-focus refetch — not the primary
 * freshness mechanism.
 */
export function useInbox() {
  return useQuery<ReadonlyArray<InboxItem>>({
    queryKey: ["me", "inbox"],
    queryFn: async () => {
      const res = await client.api.me.inbox.get();
      if (res.error || !res.data) return [];
      return res.data.items.map(toInboxItem);
    },
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
  });
}

interface InboxResponseItem {
  documentId: string;
  threadId: string | null;
  sender: string | null;
  subject: string | null;
  snippet: string | null;
  authoredAt: string | null;
  unread: boolean;
  category: string | null;
}

function toInboxItem(row: InboxResponseItem): InboxItem {
  const display = senderDisplay(row.sender);
  const domain = senderDomain(row.sender);
  const brand = brandFor(domain);
  return {
    id: row.documentId,
    threadId: row.threadId,
    sender: display || "Unknown sender",
    subject: row.subject ?? "(no subject)",
    preview: cleanPreview(row.snippet) || " ",
    time: formatRelative(row.authoredAt),
    unread: row.unread,
    initial: initialFor(display),
    tone: toneFor(display),
    category: isTriageCategory(row.category) ? (row.category as TriageCategory) : null,
    senderBrand: brand,
    // Drop personal-mail domains so the favicon fallback only kicks in
    // for corporate / transactional senders. Gmail / Outlook addresses
    // are people — they deserve the colored-initial avatar, not the
    // Gmail logo standing in for the human behind it.
    senderDomain: brand || isPersonalDomain(domain) ? null : domain || null,
  };
}

/**
 * Personal-mail domains shouldn't trigger the favicon fallback — the
 * favicon is a stand-in for "this sender is a brand," which a free
 * Gmail account isn't. List is deliberately short; everything else
 * (corporate domains, transactional senders) goes through favicons.
 */
const PERSONAL_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
]);

function isPersonalDomain(domain: string): boolean {
  if (!domain) return false;
  return PERSONAL_MAIL_DOMAINS.has(domain);
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

/** Extract the domain (e.g. `github.com`) from a raw `From` header. */
function senderDomain(raw: string | null): string {
  if (!raw) return "";
  const addr = raw.match(/<([^>]+)>/)?.[1] ?? raw;
  const at = addr.lastIndexOf("@");
  if (at < 0) return "";
  return addr
    .slice(at + 1)
    .trim()
    .toLowerCase();
}

/**
 * Map common transactional/notification domains to the brand glyph we
 * already ship in `IntegrationGlyph`. The list is intentionally narrow —
 * personal correspondents fall through to the colored-initial avatar so
 * the rail doesn't go all-monochrome.
 */
function brandFor(domain: string): IntegrationBrand | null {
  if (!domain) return null;
  if (domain.endsWith("github.com")) return "github";
  if (domain.endsWith("linear.app")) return "linear";
  if (domain.endsWith("slack.com")) return "slack";
  return null;
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
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
