import { isTriageCategory, parseEmailAddress, type TriageCategory } from "@alfred/contracts";
import type { InfiniteData } from "@tanstack/react-query";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { responseErrorMessage } from "~/lib/api-error";
import { client, type EdenData } from "~/lib/eden";
import type { IntegrationBrand } from "~/lib/integrations/integration-icons";
import type { RailInboxItem, RailToolTone } from "~/routes/-chat/rail/models";

export const INBOX_PAGE_SIZE = 8;

export interface InboxPage {
  items: ReadonlyArray<RailInboxItem>;
  nextCursor: string | null;
  total: number;
}

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
      const items = Array.isArray(res.data.items) ? res.data.items.map(toInboxItem) : [];
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

export function useMarkInboxRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (documentIds: ReadonlyArray<string>) => {
      const res = await client.api.me.inbox["mark-read"].post({
        documentIds: [...documentIds],
      });
      if (res.error) {
        throw new Error(responseErrorMessage(res.error.value, res.status, "Mark-read"));
      }
      return res.data;
    },
    onMutate: async (documentIds: ReadonlyArray<string>) => {
      const inboxKey = ["me", "inbox"];
      await queryClient.cancelQueries({ queryKey: inboxKey });
      const previous = queryClient.getQueryData<InfiniteData<InboxPage, string | null>>(inboxKey);
      const markRead = new Set(documentIds);
      queryClient.setQueryData<InfiniteData<InboxPage, string | null>>(inboxKey, (current) => {
        if (!current) return current;
        return {
          ...current,
          pages: current.pages.map((page) => ({
            ...page,
            items: page.items.map((item) =>
              item.unread && markRead.has(item.id) ? { ...item, unread: false } : item,
            ),
          })),
        };
      });
      return { previous };
    },
    onError: (_err, _documentIds, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["me", "inbox"], context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["me", "inbox"] });
    },
  });
}

export interface InboxThread {
  threadId: string | null;
  subject: string | null;
  category: TriageCategory | null;
  selectedDocumentId: string;
  messages: ReadonlyArray<InboxMessage>;
}

export interface InboxMessage {
  documentId: string;
  sender: string | null;
  senderDisplay: string;
  senderEmail: string | null;
  to: string | null;
  cc: string | null;
  subject: string | null;
  snippet: string | null;
  body: string;
  htmlBody: string | null;
  authoredAt: string | null;
  authoredAtRelative: string;
  unread: boolean;
  attachments: ReadonlyArray<InboxAttachment>;
}

type InboxDetailData = EdenData<ReturnType<typeof client.api.me.inbox>["get"]>;

export type InboxAttachment = InboxDetailData["messages"][number]["attachments"][number];

export function useInboxDetail(documentId: string | null) {
  return useQuery<InboxThread | null>({
    queryKey: ["me", "inbox", "detail", documentId],
    enabled: !!documentId,
    queryFn: async () => {
      if (!documentId) return null;
      const res = await client.api.me.inbox({ documentId }).get();
      if (res.error || !res.data) return null;
      const data = res.data;
      const messages: InboxMessage[] = Array.isArray(data.messages)
        ? data.messages.map((m) => {
            const rawSender = m.sender ?? "";
            const display = parseSenderDisplay(rawSender);
            const email = parseSenderEmail(rawSender);
            const attachments: InboxAttachment[] = Array.isArray(m.attachments)
              ? m.attachments.map((a) => ({
                  partId: a.partId ?? null,
                  attachmentId: a.attachmentId,
                  filename: a.filename,
                  mimeType: a.mimeType,
                  size: a.size,
                }))
              : [];
            return {
              documentId: m.documentId,
              sender: m.sender,
              senderDisplay: display || "Unknown sender",
              senderEmail: email,
              to: m.to,
              cc: m.cc,
              subject: m.subject,
              snippet: m.snippet ?? null,
              body: m.body,
              htmlBody: m.htmlBody ?? null,
              authoredAt: m.authoredAt,
              authoredAtRelative: formatRelativeShort(m.authoredAt),
              unread: m.unread,
              attachments,
            };
          })
        : [];
      return {
        threadId: data.threadId,
        subject: data.subject,
        category: isTriageCategory(data.category) ? (data.category as TriageCategory) : null,
        selectedDocumentId: data.selectedDocumentId,
        messages,
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

type InboxResponseItem = EdenData<typeof client.api.me.inbox.get>["items"][number];

function toInboxItem(row: InboxResponseItem): RailInboxItem {
  const display = senderDisplay(row.sender);
  const domain = senderDomain(row.sender);
  const brand = brandFor(domain);
  return {
    id: row.documentId,
    threadId: row.threadId,
    sender: display || "Unknown sender",
    senderAddress: parseEmailAddress(row.sender),
    subject: row.subject ?? "(no subject)",
    preview: cleanPreview(row.snippet) || " ",
    time: formatRelativeShort(row.authoredAt),
    authoredAtMs: row.authoredAt ? new Date(row.authoredAt).getTime() : null,
    unread: row.unread,
    initial: initialFor(display),
    tone: toneFor(display),
    category: isTriageCategory(row.category) ? (row.category as TriageCategory) : null,
    senderBrand: brand,
    senderDomain: brand === null && !isPersonalDomain(domain) && domain ? domain : null,
  };
}

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

function senderDisplay(raw: string | null): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  const beforeBracket = trimmed.split("<")[0]?.trim() ?? "";
  const unquoted = beforeBracket.replace(/^"|"$/g, "").trim();
  if (unquoted) return unquoted;
  const addr = trimmed.match(/<([^>]+)>/)?.[1] ?? trimmed;
  return addr.split("@")[0] ?? trimmed;
}

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

function brandFor(domain: string): IntegrationBrand | null {
  if (!domain) return null;
  if (matchesDomain(domain, "github.com")) return "github";
  if (matchesDomain(domain, "linear.app")) return "linear";
  if (matchesDomain(domain, "slack.com")) return "slack";
  return null;
}

function matchesDomain(host: string, base: string): boolean {
  return host === base || host.endsWith(`.${base}`);
}

function initialFor(name: string): string {
  if (!name) return "?";
  const first = name.trim().charAt(0).toUpperCase();
  return first || "?";
}

const TONE_PALETTE: ReadonlyArray<RailToolTone> = [
  "purple",
  "sky",
  "amber",
  "green",
  "pink",
  "orange",
];

function toneFor(name: string): RailToolTone {
  if (!name) return "purple";
  let hash = 5381;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) + hash + name.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % TONE_PALETTE.length;
  return TONE_PALETTE[idx] ?? "purple";
}

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

function formatRelativeShort(iso: string | null): string {
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
