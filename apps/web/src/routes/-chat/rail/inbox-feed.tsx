import {
  TRIAGE_CATEGORIES,
  TRIAGE_DISPLAY,
  type TriageCategory,
  type TriageTagSource,
} from "@alfred/contracts";
import type { SyncedTriageTag } from "@alfred/sync";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileText,
  File as FileIcon,
  FileSpreadsheet,
  Film,
  Image as ImageIcon,
  Loader2,
  Music,
  Paperclip,
  Search,
  Tag,
  X,
} from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { MarkdownRenderer } from "~/components/markdown-renderer";
import { useInboxDetail, type InboxAttachment, type InboxMessage } from "./use-inbox";
import { faviconFor as faviconUrl } from "~/lib/favicon";
import { IntegrationGlyph } from "~/lib/integrations/integration-icons";
import { cn } from "~/lib/utils";
import { hasRemoteEmailMedia } from "./inbox-feed-media";
import { APP_TINTS } from "~/lib/tints";
import { type RailInboxItem } from "./models";
import type { InboxPagination } from "./rail-data";

const PAGE_SIZE = 8;

interface InboxFeedProps {
  items: ReadonlyArray<RailInboxItem>;
  /** Server pagination. Preview routes omit it and get one local page. */
  pagination?: InboxPagination | undefined;
  /** Row open in the reader pane. When set, the reader replaces the list. */
  selectedId?: string | null | undefined;
  /** Open the reader for a row. Without it, rows link to Gmail. */
  onOpen?: ((documentId: string) => void) | undefined;
  onClose?: (() => void) | undefined;
  /** Mark the visible unread ids read. Omit it to hide "Mark all read". */
  onMarkRead?: ((documentIds: ReadonlyArray<string>) => void) | undefined;
  markReadPending?: boolean | undefined;
  /** Synced tags by Gmail thread id. Optimistic overrides go on top. */
  triageTagsByThreadId?: ReadonlyMap<string, SyncedTriageTag> | undefined;
  onOverrideTag?: ((threadId: string, category: TriageCategory) => void) | undefined;
}

/**
 * Right-rail Inbox feed: text filter, unread toggle, reader pane.
 * Presentation only; `useInbox` owns the refresh.
 */
export function InboxFeed({
  items,
  pagination,
  selectedId,
  onOpen,
  onClose,
  onMarkRead,
  markReadPending = false,
  triageTagsByThreadId,
  onOverrideTag,
}: InboxFeedProps) {
  const [query, setQuery] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [localPage, setLocalPage] = useState(0);

  const serverPaginated = !!pagination;
  const totalUnread = items.filter((i) => i.unread).length;

  // The server returns one page; filter it locally so each keystroke skips a round-trip.
  const filtered = useMemo(
    () => items.filter((item) => filterMatches(item, query, unreadOnly)),
    [items, query, unreadOnly],
  );

  const localPageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  // Clamp during render when the filter shrinks the list below the current page.
  const pageIndex = pagination?.pageIndex ?? Math.min(localPage, localPageCount - 1);
  const pageCount = pagination?.pageCount ?? localPageCount;

  const visible = useMemo(() => {
    if (serverPaginated) return filtered;

    return filtered.slice(pageIndex * PAGE_SIZE, pageIndex * PAGE_SIZE + PAGE_SIZE);
  }, [filtered, pageIndex, serverPaginated]);

  // From the visible slice, so "Mark all read" respects the filter and page.
  const visibleUnreadIds = useMemo(() => {
    const ids: string[] = [];

    for (const item of visible) {
      if (item.unread) ids.push(item.id);
    }

    return ids;
  }, [visible]);

  // The reader fetches on its own, so list filter and page state survive.
  if (selectedId && onClose) {
    return (
      <InboxDetailPane
        documentId={selectedId}
        onClose={onClose}
        triageTagsByThreadId={triageTagsByThreadId}
        onOverrideTag={onOverrideTag}
      />
    );
  }

  if (!items.length && (!pagination || pagination.total === 0)) {
    return (
      <div className="app-card-in px-2 py-4">
        <p className="text-[12px] leading-5 text-white/65">
          Connect Gmail to see your latest unread threads here.
        </p>
      </div>
    );
  }

  return (
    <div className="app-card-in space-y-2">
      <SearchBar
        value={query}
        onChange={(next) => {
          setQuery(next);

          if (!serverPaginated) setLocalPage(0);
        }}
      />

      <div className="flex items-center justify-between gap-2 px-1">
        <button
          type="button"
          onClick={() => {
            setUnreadOnly((v) => !v);

            if (!serverPaginated) setLocalPage(0);
          }}
          aria-pressed={unreadOnly}
          className={cn(
            "-mx-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5",
            "text-[10.5px] font-medium tracking-tight uppercase transition-colors",
            "outline-none focus-visible:ring-2 focus-visible:ring-white/40",
            unreadOnly
              ? "bg-app-purple-4/20 text-app-purple-4"
              : "text-white/60 hover:text-white/85",
          )}
        >
          <span
            aria-hidden
            className={cn("size-1.5 rounded-full", unreadOnly ? "bg-app-purple-4" : "bg-white/55")}
          />
          Unread · {totalUnread}
        </button>
        <div className="flex items-center gap-1.5">
          {pageCount > 1 ? (
            <Pagination
              page={pageIndex}
              pageCount={pageCount}
              isLoading={pagination?.isLoading ?? false}
              onPrev={() => {
                if (pagination) pagination.onPrev();
                else setLocalPage(Math.max(0, pageIndex - 1));
              }}
              onNext={() => {
                if (pagination) pagination.onNext();
                else setLocalPage(Math.min(localPageCount - 1, pageIndex + 1));
              }}
            />
          ) : null}
          {onMarkRead ? (
            <button
              type="button"
              disabled={visibleUnreadIds.length === 0 || markReadPending}
              onClick={() => onMarkRead(visibleUnreadIds)}
              className={cn(
                "text-[11px] text-white/65 transition-colors hover:text-white",
                "rounded outline-none focus-visible:ring-2 focus-visible:ring-white/40",
                "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-white/65",
              )}
            >
              Mark all read
            </button>
          ) : null}
        </div>
      </div>

      {items.length === 0 && pagination?.isLoading ? (
        // Page still loading after "Next": show a loader, not a flash of "No matches".
        <div className="flex items-center justify-center px-2 py-6">
          <Loader2 size={14} className="animate-spin text-white/70" aria-hidden />
        </div>
      ) : filtered.length === 0 ? (
        <div className="px-2 py-6 text-center">
          <p className="text-[12px] text-white/55">No matches.</p>
        </div>
      ) : (
        <ul className="space-y-0.5">
          {visible.map((item) => (
            <InboxRow key={item.id} item={item} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </div>
  );
}

function filterMatches(item: RailInboxItem, query: string, unreadOnly: boolean): boolean {
  if (unreadOnly && !item.unread) return false;
  const q = query.trim().toLowerCase();

  if (!q) return true;

  return (
    item.sender.toLowerCase().includes(q) ||
    item.subject.toLowerCase().includes(q) ||
    item.preview.toLowerCase().includes(q)
  );
}

function Pagination({
  page,
  pageCount,
  isLoading,
  onPrev,
  onNext,
}: {
  page: number;
  pageCount: number;
  isLoading?: boolean | undefined;
  onPrev: () => void;
  onNext: () => void;
}) {
  const prevDisabled = page === 0 || isLoading;
  const nextDisabled = page >= pageCount - 1 || isLoading;

  return (
    <div className="flex items-center gap-0.5">
      <PaginationButton label="Previous page" onClick={onPrev} disabled={prevDisabled}>
        <ChevronLeft size={12} />
      </PaginationButton>
      <span className="inline-flex min-w-[28px] items-center justify-center gap-1 px-1 text-center text-[10.5px] text-white/70 tabular-nums">
        {isLoading ? (
          <Loader2 size={10} className="animate-spin text-white/70" aria-hidden />
        ) : null}
        {page + 1}/{pageCount}
      </span>
      <PaginationButton label="Next page" onClick={onNext} disabled={nextDisabled}>
        <ChevronRight size={12} />
      </PaginationButton>
    </div>
  );
}

function PaginationButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean | undefined;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex size-6 items-center justify-center rounded-md",
        "app-press transition-colors",
        "text-white/70 hover:bg-white/10 hover:text-white",
        "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-white/70",
        "outline-none focus-visible:ring-2 focus-visible:ring-white/40",
      )}
    >
      {children}
    </button>
  );
}

function SearchBar({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div
      className={cn(
        "-mx-0.5 flex items-center gap-1.5 rounded-lg px-2 py-1.5",
        // White-alpha so the field shows on the rail's video; the purple ring is too dim there.
        "bg-white/[0.06] ring-1 ring-white/15 ring-inset",
        "focus-within:bg-white/[0.10] focus-within:ring-white/45",
        "transition-[background-color,box-shadow]",
      )}
    >
      <Search size={12} className="shrink-0 text-white/55" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Filter inbox"
        aria-label="Filter inbox"
        className={cn(
          "min-w-0 flex-1 bg-transparent text-[12px] leading-5 text-white placeholder:text-white/55",
          "outline-none",
        )}
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear filter"
          className="shrink-0 text-white/55 transition-colors hover:text-white"
        >
          <X size={12} />
        </button>
      ) : null}
    </div>
  );
}

function InboxRow({
  item,
  onOpen,
}: {
  item: RailInboxItem;
  onOpen?: ((documentId: string) => void) | undefined;
}) {
  const href = item.threadId
    ? `https://mail.google.com/mail/u/0/#inbox/${item.threadId}`
    : undefined;

  // Order: `onOpen` (reader), then a Gmail link, then static. Do not make a row with no action focusable.
  const interactive = !!onOpen || !!href;
  // ADR-0064 / #210: dim `muted` rows (machine noise, cold senders); hover restores. The category chip stays.
  const muted = item.attentionBand === "muted";

  const sharedClass = cn(
    "group relative -mx-0.5 w-full rounded-xl p-2 text-left",
    "flex items-start gap-2.5",
    muted && "opacity-55 hover:opacity-100 focus-visible:opacity-100",
    interactive
      ? cn(
          "app-press transition-[background-color,opacity] hover:bg-white/[0.07]",
          "outline-none focus-visible:ring-2 focus-visible:ring-white/40",
        )
      : "cursor-default",
  );

  const body = (
    <>
      {/* Unread stripe; transparent on read rows so the layout does not shift. */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-2 left-0 w-[2px] rounded-full transition-colors",
          item.unread ? "bg-app-purple-4" : "bg-transparent",
        )}
      />

      <SenderAvatar item={item} />

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span
            className={cn(
              "min-w-0 truncate text-[13px] leading-5",
              item.unread ? "font-medium text-white" : "text-white/75",
            )}
          >
            {item.sender}
          </span>
          <span className="ml-auto inline-flex shrink-0 items-center gap-1.5">
            {item.category ? (
              <CategoryChip category={item.category} source={item.categorySource} />
            ) : null}
            <span className="text-[11px] text-white/55 tabular-nums">{item.time}</span>
          </span>
        </span>
        <span
          className={cn(
            "block truncate text-[12px] leading-4",
            item.unread ? "text-white/80" : "text-white/60",
          )}
        >
          {item.subject}
        </span>
        <span
          className={cn(
            "block truncate text-[11px] leading-4",
            item.unread ? "text-white/60" : "text-white/45",
          )}
        >
          {item.preview}
        </span>
      </span>
    </>
  );

  return (
    <li>
      {onOpen ? (
        <button type="button" onClick={() => onOpen(item.id)} className={sharedClass}>
          {body}
        </button>
      ) : href ? (
        <a href={href} target="_blank" rel="noreferrer noopener" className={sharedClass}>
          {body}
        </a>
      ) : (
        <div className={sharedClass}>{body}</div>
      )}
    </li>
  );
}

function SenderAvatar({ item }: { item: RailInboxItem }) {
  if (item.senderBrand) {
    return (
      <span
        aria-hidden
        className={cn(
          "mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full",
          "bg-white/10 ring-1 ring-white/15 ring-inset",
        )}
      >
        <IntegrationGlyph brand={item.senderBrand} size={16} />
      </span>
    );
  }

  // Favicon fallback; on error, hide it to show the initial behind it.
  if (item.senderDomain) {
    return (
      <span
        aria-hidden
        className={cn(
          "relative mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full",
          "overflow-hidden text-[11px] font-semibold tabular-nums",
          APP_TINTS[item.tone],
        )}
      >
        <span className="absolute inset-0 inline-flex items-center justify-center">
          {item.initial}
        </span>
        <img
          src={faviconUrl(item.senderDomain)}
          alt=""
          loading="lazy"
          decoding="async"
          className={cn(
            "relative z-10 size-4 rounded-[3px]",
            "bg-white/85 p-[1px] dark:bg-white/90",
          )}
          onError={(e) => {
            e.currentTarget.style.display = "none";
          }}
        />
      </span>
    );
  }

  return (
    <span
      aria-hidden
      className={cn(
        "mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full",
        "text-[11px] font-semibold tabular-nums",
        APP_TINTS[item.tone],
      )}
    >
      {item.initial}
    </span>
  );
}

/** Triage chip: red urgent, amber action, sky follow-up/meeting, green done, gray the rest. */
function CategoryChip({
  category,
  source,
  onChange,
}: {
  category: TriageCategory;
  source?: TriageTagSource | null | undefined;
  onChange?: ((category: TriageCategory) => void) | undefined;
}) {
  const chipClass = cn(
    "inline-flex h-4 items-center rounded-md px-1.5",
    "text-[10px] font-medium tracking-tight whitespace-nowrap uppercase",
    source === "user" && "gap-1 ring-1 ring-current/25 ring-inset",
    CATEGORY_CHIP[category],
  );

  const contents = (
    <>
      {source === "user" ? <Tag size={9} aria-hidden /> : null}
      {TRIAGE_DISPLAY[category]}
    </>
  );

  const sourceSuffix = source === "user" ? ", user override" : "";

  if (!onChange) {
    return (
      <span
        className={chipClass}
        title={source === "user" ? "User override" : undefined}
        aria-label={
          source === "user" ? `${TRIAGE_DISPLAY[category]} triage tag${sourceSuffix}` : undefined
        }
      >
        {contents}
      </span>
    );
  }

  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <button
          type="button"
          className={cn(
            chipClass,
            "relative transition-[filter,box-shadow] hover:brightness-110",
            "before:absolute before:-inset-1.5 before:content-['']",
            "outline-none focus-visible:ring-2 focus-visible:ring-white/40",
          )}
          aria-label={`Change triage tag, currently ${TRIAGE_DISPLAY[category]}${sourceSuffix}`}
        >
          {contents}
        </button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="start"
          sideOffset={6}
          className={cn(
            "z-50 min-w-[168px] rounded-lg p-1",
            "bg-app-bg-1/95 text-app-fg-4 shadow-xl ring-1 ring-white/15 backdrop-blur",
          )}
        >
          {TRIAGE_CATEGORIES.map((option) => (
            <DropdownMenuPrimitive.Item
              key={option}
              onSelect={() => onChange(option)}
              className={cn(
                "flex h-8 cursor-default items-center gap-2 rounded-md px-2 select-none",
                "text-[12px] outline-none data-[highlighted]:bg-white/10",
              )}
            >
              <span aria-hidden className={cn("size-2 rounded-full", CATEGORY_SWATCH[option])} />
              <span className="min-w-0 flex-1 truncate">{TRIAGE_DISPLAY[option]}</span>
              {option === category ? (
                <Check size={12} className="text-app-fg-3" aria-hidden />
              ) : null}
            </DropdownMenuPrimitive.Item>
          ))}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

const CATEGORY_CHIP = {
  urgent: "bg-app-red-1 text-app-red-4",
  action_needed: "bg-app-amber-1 text-app-amber-4",
  awaiting_reply: "bg-app-amber-1 text-app-amber-4",
  payment: "bg-app-amber-1 text-app-amber-4",
  follow_up: "bg-app-sky-1 text-app-sky-4",
  meeting: "bg-app-sky-1 text-app-sky-4",
  // Gray is white-alpha: theme tokens disappear on the rail's dark video.
  fyi: "bg-white/10 text-white/75",
  done: "bg-app-green-1 text-app-green-4",
  newsletter: "bg-white/10 text-white/75",
  marketing: "bg-white/10 text-white/75",
} satisfies Record<TriageCategory, string>;

const CATEGORY_SWATCH = {
  urgent: "bg-app-red-4",
  action_needed: "bg-app-amber-4",
  awaiting_reply: "bg-app-amber-4",
  payment: "bg-app-amber-4",
  follow_up: "bg-app-sky-4",
  meeting: "bg-app-sky-4",
  fyi: "bg-app-fg-2",
  done: "bg-app-green-4",
  newsletter: "bg-app-fg-2",
  marketing: "bg-app-fg-2",
} satisfies Record<TriageCategory, string>;

/**
 * Thread reader: every message in the thread, oldest first, with a ring on the clicked one.
 * Read only: there is no rail send API yet.
 */
function InboxDetailPane({
  documentId,
  onClose,
  triageTagsByThreadId,
  onOverrideTag,
}: {
  documentId: string;
  onClose: () => void;
  triageTagsByThreadId?: ReadonlyMap<string, SyncedTriageTag> | undefined;
  onOverrideTag?: ((threadId: string, category: TriageCategory) => void) | undefined;
}) {
  const { data, isLoading, isError } = useInboxDetail(documentId);
  const threadId = data?.threadId ?? null;
  const syncedTag = threadId ? triageTagsByThreadId?.get(threadId) : undefined;
  const displayedCategory = syncedTag?.category ?? data?.category ?? null;
  const displayedSource = syncedTag?.source ?? null;

  const changeCategory =
    syncedTag && onOverrideTag
      ? (category: TriageCategory) => onOverrideTag(syncedTag.threadId, category)
      : undefined;

  return (
    <div className="app-card-in flex flex-col gap-3 px-1">
      <div className="flex items-center justify-between gap-2 px-1">
        <button
          type="button"
          onClick={onClose}
          className={cn(
            "-mx-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1",
            // White-alpha, not theme tokens: the video is dark in both themes.
            "text-[11px] font-medium tracking-tight text-white/65 uppercase",
            "transition-colors hover:bg-white/10 hover:text-white",
            "outline-none focus-visible:ring-2 focus-visible:ring-white/40",
          )}
        >
          <ArrowLeft size={12} />
          Back
        </button>
        {data?.threadId ? (
          <a
            href={`https://mail.google.com/mail/u/0/#inbox/${data.threadId}`}
            target="_blank"
            rel="noreferrer noopener"
            className={cn(
              "inline-flex items-center gap-1 text-[11px] text-white/65",
              "transition-colors hover:text-white",
              "outline-none focus-visible:ring-2 focus-visible:ring-white/40",
              "-mx-1.5 rounded-md px-1.5 py-1",
            )}
          >
            Open in Gmail
            <ExternalLink size={11} />
          </a>
        ) : null}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center px-2 py-8">
          <Loader2 size={16} className="animate-spin text-white/70" aria-hidden />
        </div>
      ) : isError || !data ? (
        <div className="px-2 py-6 text-center">
          <p className="text-[12px] text-white/60">Couldn't load this email.</p>
        </div>
      ) : (
        <article className="space-y-3 px-1">
          <header className="space-y-1.5">
            <h3 className="text-[14px] leading-5 font-medium wrap-break-word text-white">
              {data.subject || "(no subject)"}
            </h3>
            <div className="flex flex-wrap items-center gap-2">
              {displayedCategory ? (
                <CategoryChip
                  category={displayedCategory}
                  source={displayedSource}
                  onChange={changeCategory}
                />
              ) : null}
              <span className="text-[11px] text-white/60 tabular-nums">
                {data.messages.length} message
                {data.messages.length === 1 ? "" : "s"}
              </span>
            </div>
          </header>
          {data.messages.length === 0 ? (
            <p className="px-1 text-[12px] text-white/60">(no messages)</p>
          ) : (
            <ol className="space-y-2.5">
              {data.messages.map((m, i) => (
                <li key={m.documentId}>
                  <ThreadMessageCard
                    message={m}
                    isSelected={m.documentId === data.selectedDocumentId}
                    threadId={data.threadId}
                    /* Open the last message and the clicked one; collapse the rest. */
                    defaultOpen={
                      m.documentId === data.selectedDocumentId || i === data.messages.length - 1
                    }
                  />
                </li>
              ))}
            </ol>
          )}
        </article>
      )}
    </div>
  );
}

/**
 * One message in the thread timeline: a one-line row when collapsed.
 * Expanded, it has a per-message Reader / Original toggle.
 */
function ThreadMessageCard({
  message,
  isSelected,
  threadId,
  defaultOpen,
}: {
  message: InboxMessage;
  isSelected: boolean;
  threadId: string | null;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // The parent keys this card by documentId, so a new message resets the view.
  const [view, setView] = useState<"reader" | "original">("reader");

  const hasHtml = !!message.htmlBody;

  const summary = useMemo(
    () => buildSnippet(message.snippet, message.body),
    [message.snippet, message.body],
  );

  return (
    <div
      className={cn(
        // `app-purple-3` is the one purple step with the same hex in both themes.
        "rounded-xl bg-white/[0.07] ring-1 ring-white/15",
        "transition-shadow",
        isSelected && "ring-2 ring-app-purple-3",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-start gap-2 rounded-xl px-2.5 py-2 text-left",
          "transition-colors hover:bg-white/[0.06]",
          "outline-none focus-visible:ring-2 focus-visible:ring-white/40",
        )}
        aria-expanded={open}
      >
        <SenderInitialAvatar name={message.senderDisplay} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 truncate text-[12.5px] font-medium text-white">
              {message.senderDisplay}
            </span>
            {message.authoredAtRelative ? (
              <span className="ml-auto shrink-0 text-[11px] text-white/55 tabular-nums">
                {message.authoredAtRelative}
              </span>
            ) : null}
          </span>
          {!open && summary ? (
            <span className="mt-0.5 block truncate text-[11.5px] text-white/60">{summary}</span>
          ) : null}
          {open && message.senderEmail ? (
            <span className="mt-0.5 block truncate text-[11px] text-white/55">
              {message.senderEmail}
            </span>
          ) : null}
        </span>
      </button>

      {open ? (
        <div className="space-y-2 px-2.5 pb-2.5">
          {hasHtml ? <ViewToggle value={view} onChange={setView} /> : null}
          {/* Fixed dark glass: `bg-app-bg-1` is white in light mode and washes out over the video. */}
          <div className="overflow-hidden rounded-lg bg-black/25 ring-1 ring-white/10">
            {view === "original" && message.htmlBody ? (
              <EmailHtmlFrame html={message.htmlBody} />
            ) : message.body.trim() ? (
              <div className="px-3 py-2.5">
                {/* #294: alt text only, so a tracker pixel makes no request. */}
                <MarkdownRenderer tone="media" images="alt-text">
                  {message.body.trim()}
                </MarkdownRenderer>
              </div>
            ) : (
              <p className="px-3 py-2.5 text-[12px] text-white/55 italic">(empty body)</p>
            )}
          </div>
          {message.attachments.length > 0 ? (
            <AttachmentStrip attachments={message.attachments} threadId={threadId} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Preview for the collapsed row when Gmail's snippet is missing or full of entities. */
function buildSnippet(snippet: string | null, body: string): string {
  const s = (snippet ?? "").trim();

  if (s) return s;

  // Skip "On Mon, … wrote:" lines and signatures.
  const firstLine = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith(">") && !/^on .+wrote:/i.test(l));

  return (firstLine ?? "").slice(0, 140);
}

function ViewToggle({
  value,
  onChange,
}: {
  value: "reader" | "original";
  onChange: (next: "reader" | "original") => void;
}) {
  return (
    <fieldset className="inline-flex items-center gap-0 rounded-md border-0 bg-black/25 p-0.5 text-[10.5px] font-medium tracking-tight uppercase ring-1 ring-white/15">
      <legend className="sr-only">Message view</legend>
      <ToggleButton active={value === "reader"} onClick={() => onChange("reader")}>
        Reader
      </ToggleButton>
      <ToggleButton active={value === "original"} onClick={() => onChange("original")}>
        Original
      </ToggleButton>
    </fieldset>
  );
}

function ToggleButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "app-press rounded px-1.5 py-0.5 transition-colors",
        "outline-none focus-visible:ring-2 focus-visible:ring-white/40",
        active ? "bg-white/[0.16] text-white" : "text-white/60 hover:text-white/85",
      )}
    >
      {children}
    </button>
  );
}

/** The strict CSP meta from `sanitizeEmailHtml` (#294). */
const CSP_META_RE = /<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i;

/** "Display remote media": http(s) images and video allowed; all else stays blocked. */
const LOOSE_CSP_META =
  `<meta http-equiv="Content-Security-Policy" content="` +
  `default-src 'none'; img-src http: https: data: cid:; media-src http: https:; font-src 'none'; ` +
  `connect-src 'none'; frame-src 'none'; object-src 'none'; script-src 'none'; ` +
  `style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">`;

/**
 * Email HTML in a sandboxed iframe. DOMPurify already ran on the server.
 * `allow-same-origin` without `allow-scripts` lets the parent read the height; no script can abuse it.
 * Remote media (#294) loads only after a per-message opt-in, which resets on collapse.
 */
function EmailHtmlFrame({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(200);
  const [showRemoteMedia, setShowRemoteMedia] = useState(false);

  // Else every plain Original body shows a false warning.
  const canDisplayRemoteMedia = CSP_META_RE.test(html) && hasRemoteEmailMedia(html);

  const srcDoc =
    showRemoteMedia && canDisplayRemoteMedia ? html.replace(CSP_META_RE, LOOSE_CSP_META) : html;

  useLayoutEffect(() => {
    const frame = ref.current;

    if (!frame) return;
    let cancelled = false;
    let observer: ResizeObserver | null = null;

    const measure = () => {
      if (cancelled) return;
      const doc = frame.contentDocument;

      if (!doc?.body) return;

      // `documentElement` includes the bottom margin that body misses. Cap the height.
      const h = Math.min(
        Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight, 80),
        2400,
      );

      setHeight(h);
    };

    const onLoad = () => {
      measure();
      const doc = frame.contentDocument;

      if (doc?.body && typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(() => measure());
        observer.observe(doc.body);
      }
    };

    frame.addEventListener("load", onLoad);

    // `load` can fire before the listener attaches for a srcDoc frame.
    if (frame.contentDocument?.readyState === "complete") onLoad();

    return () => {
      cancelled = true;
      frame.removeEventListener("load", onLoad);
      observer?.disconnect();
    };
    // Includes the remote-media swap.
  }, [srcDoc]);

  return (
    <div>
      {canDisplayRemoteMedia && !showRemoteMedia ? (
        <div className="flex items-center justify-between gap-2 border-b border-black/10 bg-black/[0.03] px-3 py-1.5">
          <span className="text-[11px] text-black/55">Remote images are blocked.</span>
          <button
            type="button"
            onClick={() => setShowRemoteMedia(true)}
            className={cn(
              "app-press shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium",
              "text-black/70 ring-1 ring-black/15 hover:bg-black/[0.06]",
              "outline-none focus-visible:ring-2 focus-visible:ring-black/40",
            )}
          >
            Display remote media
          </button>
        </div>
      ) : null}
      <iframe
        ref={ref}
        title="Email body"
        srcDoc={srcDoc}
        // No `allow-scripts`. Popups let `<base target="_blank">` open links in a new tab.
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        // Do not leak the chat URL.
        referrerPolicy="no-referrer"
        className="block w-full bg-white"
        style={{ height, border: 0, colorScheme: "light" }}
      />
    </div>
  );
}

/** Monogram avatar, same tone mapping as the inbox rows. */
function SenderInitialAvatar({ name }: { name: string }) {
  const tone = useMemo(() => toneFromName(name), [name]);
  const initial = (name.trim().charAt(0) || "?").toUpperCase();

  return (
    <span
      aria-hidden
      className={cn(
        "mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full",
        "text-[10.5px] font-semibold",
        tone,
      )}
    >
      {initial}
    </span>
  );
}

const TONE_CLASSES = [
  "bg-app-purple-1 text-app-purple-4",
  "bg-app-sky-1 text-app-sky-4",
  "bg-app-amber-1 text-app-amber-4",
  "bg-app-green-1 text-app-green-4",
  "bg-app-red-1 text-app-red-4",
] as const;

function toneFromName(name: string): string {
  if (!name) return TONE_CLASSES[0];
  let hash = 5381;

  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) + hash + name.charCodeAt(i)) | 0;
  }

  const idx = Math.abs(hash) % TONE_CLASSES.length;

  return TONE_CLASSES[idx] ?? TONE_CLASSES[0];
}

/** Attachment downloads need an OAuth token we keep off the browser, so chips link to the Gmail thread. */
function AttachmentStrip({
  attachments,
  threadId,
}: {
  attachments: ReadonlyArray<InboxAttachment>;
  threadId: string | null;
}) {
  const gmailHref = threadId ? `https://mail.google.com/mail/u/0/#inbox/${threadId}` : null;

  return (
    <section aria-label="Attachments" className="space-y-1.5">
      <div className="flex items-center gap-1.5 px-0.5">
        <Paperclip size={11} className="text-white/60" aria-hidden />
        <span className="text-[10.5px] font-medium tracking-tight text-white/60 uppercase">
          {attachments.length} attachment{attachments.length === 1 ? "" : "s"}
        </span>
      </div>
      <ul className="flex flex-col gap-1">
        {attachments.map((a) => (
          <AttachmentRow key={a.attachmentId} attachment={a} href={gmailHref} />
        ))}
      </ul>
    </section>
  );
}

function AttachmentRow({ attachment, href }: { attachment: InboxAttachment; href: string | null }) {
  const { tone, icon: Icon } = attachmentVisual(attachment.mimeType, attachment.filename);

  const body = (
    <>
      <span
        aria-hidden
        className={cn(
          "inline-flex shrink-0 items-center justify-center",
          "size-8 rounded-md",
          tone,
        )}
      >
        <Icon size={14} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] leading-4 font-medium text-white">
          {attachment.filename}
        </span>
        <span className="block text-[11px] leading-4 text-white/55 tabular-nums">
          {formatBytes(attachment.size)}
          {attachment.mimeType ? (
            <>
              <span aria-hidden className="mx-1 opacity-60">
                ·
              </span>
              <span className="tracking-tight uppercase">
                {extensionFor(attachment.filename, attachment.mimeType)}
              </span>
            </>
          ) : null}
        </span>
      </span>
      {href ? <ExternalLink size={12} className="shrink-0 text-white/55" aria-hidden /> : null}
    </>
  );

  const shared = cn(
    "group flex items-center gap-2.5 rounded-lg px-2 py-1.5",
    "bg-white/[0.07] ring-1 ring-white/15",
    href
      ? cn(
          "transition-colors hover:bg-white/[0.10] hover:ring-white/25",
          "outline-none focus-visible:ring-2 focus-visible:ring-white/40",
        )
      : "",
  );

  return (
    <li>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className={shared}
          title="Open in Gmail to download"
        >
          {body}
        </a>
      ) : (
        <div className={shared}>{body}</div>
      )}
    </li>
  );
}

/** Icon and tone for an attachment. Uses the extension when the mime is `application/octet-stream`. */
function attachmentVisual(mimeType: string, filename: string) {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const mime = mimeType.toLowerCase();

  if (mime.startsWith("image/")) {
    return { tone: "bg-app-purple-1 text-app-purple-4", icon: ImageIcon };
  }

  if (mime.startsWith("video/")) {
    return { tone: "bg-app-sky-1 text-app-sky-4", icon: Film };
  }

  if (mime.startsWith("audio/")) {
    return { tone: "bg-app-sky-1 text-app-sky-4", icon: Music };
  }

  if (mime === "application/pdf" || ext === "pdf") {
    return { tone: "bg-app-red-1 text-app-red-4", icon: FileText };
  }

  if (
    mime.includes("spreadsheet") ||
    mime === "text/csv" ||
    ext === "csv" ||
    ext === "xlsx" ||
    ext === "xls"
  ) {
    return { tone: "bg-app-green-1 text-app-green-4", icon: FileSpreadsheet };
  }

  if (
    mime.includes("word") ||
    mime === "text/plain" ||
    ext === "doc" ||
    ext === "docx" ||
    ext === "txt" ||
    ext === "md"
  ) {
    return { tone: "bg-app-amber-1 text-app-amber-4", icon: FileText };
  }

  return { tone: "bg-white/10 text-white/80", icon: FileIcon };
}

function extensionFor(filename: string, mimeType: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();

  if (ext && ext.length <= 5 && ext !== filename.toLowerCase()) return ext;
  // Label common mimes when the filename has no extension.
  const mime = mimeType.toLowerCase();

  if (mime === "application/pdf") return "pdf";

  if (mime.startsWith("image/")) return mime.slice(6);

  if (mime.startsWith("video/")) return mime.slice(6);

  if (mime.startsWith("audio/")) return mime.slice(6);

  return "";
}

const KIB = 1024;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";

  if (bytes < KIB) return `${bytes} B`;

  if (bytes < KIB * KIB) return `${(bytes / KIB).toFixed(1)} KB`;

  if (bytes < KIB * KIB * KIB) return `${(bytes / (KIB * KIB)).toFixed(1)} MB`;

  return `${(bytes / (KIB * KIB * KIB)).toFixed(1)} GB`;
}
