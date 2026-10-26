import {
  collapseWhitespace,
  decodeHtmlEntities,
  INBOX_DEFAULT_LIMIT,
  isDomainOrSubdomain,
  isFreeMail,
  isTriageCategory,
  mailboxLabel,
  parseMailbox,
  type TriageCategory,
} from "@alfred/contracts";
import type { InfiniteData } from "@tanstack/react-query";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { responseErrorMessage } from "~/lib/api-error";
import { client, type EdenData } from "~/lib/eden";
import type { IntegrationBrand } from "~/lib/integrations/integration-icons";
import type { AppTint } from "~/lib/tints";
import type { RailInboxItem } from "~/routes/-chat/rail/models";

const INITIAL_PAGE_PARAM: string | null = null;

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
          limit: INBOX_DEFAULT_LIMIT,
          ...(pageParam ? { cursor: pageParam } : {}),
        },
      });

      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Eden treaty `data` is the server's JSON typed by its route, not parsed here; an empty body or a skewed deploy can leave it null.
      if (res.error || !res.data) {
        return { items: [], nextCursor: null, total: 0 };
      }

      const items = Array.isArray(res.data.items) ? res.data.items.map(toInboxItem) : [];

      return {
        items,
        nextCursor: res.data.nextCursor ?? null,
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- Eden treaty `data` is the server's JSON typed by its route, not parsed here; an empty body or a skewed deploy can leave it null.
        total: res.data.total ?? items.length,
      };
    },
    initialPageParam: INITIAL_PAGE_PARAM,
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
  initial: string;
  tone: AppTint;
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

      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Eden treaty `data` is the server's JSON typed by its route, not parsed here; an empty body or a skewed deploy can leave it null.
      if (res.error || !res.data) return null;
      const data = res.data;

      const messages: InboxMessage[] = Array.isArray(data.messages)
        ? data.messages.map((m) => {
            const sender = senderView(m.sender);

            const attachments: InboxAttachment[] = m.attachments.map((a) => ({
              partId: a.partId ?? null,
              attachmentId: a.attachmentId,
              filename: a.filename,
              mimeType: a.mimeType,
              size: a.size,
            }));

            return {
              documentId: m.documentId,
              sender: m.sender,
              senderDisplay: sender.label,
              senderEmail: sender.email,
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
              initial: sender.initial,
              tone: sender.tone,
            };
          })
        : [];

      return {
        threadId: data.threadId,
        subject: data.subject,
        category: isTriageCategory(data.category) ? data.category : null,
        selectedDocumentId: data.selectedDocumentId,
        messages,
      };
    },
    staleTime: 30_000,
    gcTime: 5 * 60_000,
  });
}

interface SenderView {
  label: string;
  email: string | null;
  domain: string;
  initial: string;
  tone: AppTint;
}

/** One parse of a `From:` value, so the list and the thread show one label and one tint. */
function senderView(raw: string | null | undefined): SenderView {
  const mailbox = parseMailbox(raw);
  const name = mailboxLabel(raw) ?? "";

  return {
    label: name || "Unknown sender",
    email: mailbox?.address ?? null,
    domain: mailbox?.domain ?? "",
    initial: initialFor(name),
    tone: toneFor(name),
  };
}

type InboxResponseItem = EdenData<typeof client.api.me.inbox.get>["items"][number];

function toInboxItem(row: InboxResponseItem): RailInboxItem {
  const sender = senderView(row.sender);
  const domain = sender.domain;
  const brand = brandFor(domain);

  return {
    id: row.documentId,
    threadId: row.threadId,
    sender: sender.label,
    senderAddress: sender.email,
    subject: row.subject ?? "(no subject)",
    preview: cleanPreview(row.snippet) || " ",
    time: formatRelativeShort(row.authoredAt),
    authoredAtMs: row.authoredAt ? new Date(row.authoredAt).getTime() : null,
    unread: row.unread,
    initial: sender.initial,
    tone: sender.tone,
    category: isTriageCategory(row.category) ? row.category : null,
    senderBrand: brand,
    senderDomain: brand === null && !isFreeMail(domain) && domain ? domain : null,
  };
}

function brandFor(domain: string): IntegrationBrand | null {
  if (!domain) return null;

  if (isDomainOrSubdomain(domain, "github.com")) return "github";

  if (isDomainOrSubdomain(domain, "linear.app")) return "linear";

  if (isDomainOrSubdomain(domain, "slack.com")) return "slack";

  return null;
}

function initialFor(name: string): string {
  if (!name) return "?";
  const first = name.trim().charAt(0).toUpperCase();

  return first || "?";
}

const TONE_PALETTE: ReadonlyArray<AppTint> = ["purple", "sky", "amber", "green", "pink", "orange"];

function toneFor(name: string): AppTint {
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

  return collapseWhitespace(decodeHtmlEntities(snippet));
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
