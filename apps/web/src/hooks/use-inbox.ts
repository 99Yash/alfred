import { isTriageCategory, type TriageCategory } from "@alfred/contracts";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { client } from "~/lib/eden";
import type { IntegrationBrand } from "~/lib/integration-icons";
import type { InboxItem, ToolTone } from "~/routes/-preview-chat/helpers";

export const INBOX_PAGE_SIZE = 8;

export interface InboxPage {
  items: ReadonlyArray<InboxItem>;
  nextCursor: string | null;
  total: number;
}

/**
 * Recent Gmail threads for the rail's Inbox tab, paginated server-side.
 *
 * `useInfiniteQuery` accumulates pages in `data.pages[0..N]` so going
 * back to an already-loaded page is instant. `InboxFeed` owns the
 * page-index UI; this hook just exposes `fetchNextPage()` for advancing.
 *
 * The endpoint is best-effort: a 401 (Gmail not connected) and an empty
 * 200 both surface as `items = []`, which `InboxFeed` renders as the
 * "Connect Gmail to see your latest unread threads here" empty state.
 *
 * Refresh: SSE `inbox.updated` frames invalidate this query in real time
 * (wired in `useEventBridge` against the `["me","inbox"]` prefix), so
 * the explicit poll is a slow backstop for dropped frames + a fresh
 * window-focus refetch — not the primary freshness mechanism.
 */
export function useInbox() {
  return useInfiniteQuery({
    queryKey: ["me", "inbox"],
    queryFn: async ({ pageParam }: { pageParam: string | null }) => {
      const res = await client.api.me.inbox.get({
        query: {
          limit: INBOX_PAGE_SIZE,
          ...(pageParam ? { cursor: pageParam } : {}),
        },
      });
      if (res.error || !res.data) {
        return { items: [], nextCursor: null, total: 0 };
      }
      const items = Array.isArray(res.data.items)
        ? res.data.items.map(toInboxItem)
        : [];
      return {
        items,
        nextCursor: res.data.nextCursor ?? null,
        total: res.data.total ?? items.length,
      };
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage: InboxPage) => lastPage.nextCursor ?? null,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
  });
}

/**
 * Full payload for one inbox row — drives the rail's single-email reader.
 * Returns `null` when the document doesn't exist or the user isn't
 * authorized; the reader pane renders a "Not found" state in that case.
 */
export interface InboxDetail {
  documentId: string;
  threadId: string | null;
  sender: string | null;
  senderDisplay: string;
  senderEmail: string | null;
  to: string | null;
  cc: string | null;
  subject: string | null;
  body: string;
  authoredAt: string | null;
  authoredAtRelative: string;
  unread: boolean;
  category: TriageCategory | null;
}

export function useInboxDetail(documentId: string | null) {
  return useQuery<InboxDetail | null>({
    queryKey: ["me", "inbox", "detail", documentId],
    enabled: !!documentId,
    queryFn: async () => {
      if (!documentId) return null;
      const res = await client.api.me
        .inbox({ documentId })
        .get();
      if (res.error || !res.data) return null;
      const data = res.data;
      const rawSender = data.sender ?? "";
      const display = parseSenderDisplay(rawSender);
      const email = parseSenderEmail(rawSender);
      return {
        documentId: data.documentId,
        threadId: data.threadId,
        sender: data.sender,
        senderDisplay: display || "Unknown sender",
        senderEmail: email,
        to: data.to,
        cc: data.cc,
        subject: data.subject,
        body: data.body,
        authoredAt: data.authoredAt,
        authoredAtRelative: formatRelative(data.authoredAt),
        unread: data.unread,
        category: isTriageCategory(data.category)
          ? (data.category as TriageCategory)
          : null,
      };
    },
    staleTime: 30_000,
    gcTime: 5 * 60_000,
  });
}

function parseSenderDisplay(raw: string): string {
  if (!raw) return "";
  const before = raw.split("<")[0]?.trim() ?? "";
  const unquoted = before.replace(/^"|"$/g, "").trim();
  if (unquoted) return unquoted;
  const addr = raw.match(/<([^>]+)>/)?.[1] ?? raw;
  return addr.split("@")[0] ?? raw;
}

function parseSenderEmail(raw: string): string | null {
  if (!raw) return null;
  const angle = raw.match(/<([^>]+)>/)?.[1];
  if (angle) return angle.trim();
  if (raw.includes("@")) return raw.trim();
  return null;
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
    senderDomain: brand === null && !isPersonalDomain(domain) && domain ? domain : null,
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
  if (matchesDomain(domain, "github.com")) return "github";
  if (matchesDomain(domain, "linear.app")) return "linear";
  if (matchesDomain(domain, "slack.com")) return "slack";
  return null;
}

/**
 * Match `host` exactly or as a strict subdomain of `base`. Guards against
 * the obvious `endsWith` trap where `evilgithub.com` would otherwise be
 * classified as GitHub.
 */
function matchesDomain(host: string, base: string): boolean {
  return host === base || host.endsWith(`.${base}`);
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
