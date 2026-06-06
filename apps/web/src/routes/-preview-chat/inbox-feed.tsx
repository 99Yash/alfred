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
import { useInboxDetail, type InboxAttachment, type InboxMessage } from "~/hooks/use-inbox";
import { IntegrationGlyph } from "~/lib/integration-icons";
import { cn } from "~/lib/utils";
import { TOOL_TONE, type InboxItem } from "./helpers";
import type { InboxPagination } from "./rail-content";

const PAGE_SIZE = 8;

/**
 * Google's free favicon CDN. Returns a per-domain logo when one exists
 * (LinkedIn, Notion, Vercel, Stripe …); 404s for domains with no
 * favicon, which we catch via the `<img>` onError fallback below.
 */
function faviconUrl(domain: string, size = 64): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=${size}`;
}

/**
 * Right-rail Inbox feed.
 *
 * Renders the top ~12 Gmail rows surfaced by `/api/me/inbox`. Each row
 * carries the triage `category` (when classified) and the sender's
 * domain-derived brand. The list supports:
 *
 *  - quick text filter over sender/subject/preview;
 *  - unread-only toggle (driven by the same `unread` flag the API exports);
 *  - click-through to Gmail web via the row's `threadId`.
 *
 * The component is presentation-only — refresh cadence (window-focus +
 * 60s poll) lives in `useInbox`.
 */
export interface InboxFeedProps {
  items: ReadonlyArray<InboxItem>;
  /** Optional server-driven pagination. When omitted, local filtering still
   * supports a single page (no controls shown) — used by preview routes. */
  pagination?: InboxPagination;
  /** Document id of the row currently expanded in the reader pane. When
   * non-null, the feed swaps the list out for `InboxDetailPane`. */
  selectedId?: string | null;
  /** Open the reader for a given row. Rendered as a link to Gmail when omitted. */
  onOpen?: (documentId: string) => void;
  /** Close the reader and return to the list. */
  onClose?: () => void;
  /**
   * Optional bulk "mark read" — when present, the feed renders a
   * "Mark all read" affordance that fires with the *visible* unread
   * ids. Preview routes (and any caller that wants to suppress the
   * action) omit this. */
  onMarkRead?: (documentIds: ReadonlyArray<string>) => void;
  /** True while a mark-read request is in flight — disables the button. */
  markReadPending?: boolean;
  /** Synced tag rows keyed by Gmail thread id; overlays optimistic overrides. */
  triageTagsByThreadId?: ReadonlyMap<string, SyncedTriageTag>;
  /** Pin a thread to a user-chosen triage category. */
  onOverrideTag?: (threadId: string, category: TriageCategory) => void;
}

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

  // Server-driven pagination owns the cursor; local-only mode keeps a
  // simple page index for fixture / preview usage where filtering is the
  // primary slicer.
  const serverPaginated = !!pagination;
  const totalUnread = items.filter((i) => i.unread).length;

  // Server already returns just the current page — local filter is applied
  // on top so the unread toggle / text search work without forcing a server
  // round-trip per keystroke. Limits the rail to filtering the visible page,
  // which is acceptable for a single-user inbox; the server query covers the
  // cross-page slice.
  const filtered = useMemo(
    () => items.filter((item) => filterMatches(item, query, unreadOnly)),
    [items, query, unreadOnly],
  );

  const localPageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  // Clamp during render — when the filter (or the `items` prop) shrinks
  // the result set below the parked page, the rail shows the last valid
  // page without a state write. Prev/next handlers read off `pageIndex`
  // (the clamped value) so a stale `localPage` doesn't strand the user.
  const pageIndex = pagination?.pageIndex ?? Math.min(localPage, localPageCount - 1);
  const pageCount = pagination?.pageCount ?? localPageCount;

  const visible = useMemo(() => {
    if (serverPaginated) return filtered;
    return filtered.slice(pageIndex * PAGE_SIZE, pageIndex * PAGE_SIZE + PAGE_SIZE);
  }, [filtered, pageIndex, serverPaginated]);

  // Ids the "Mark all read" button will pass to the parent. Drawn from
  // the visible slice (not `items`) so the button respects the user's
  // current filter + page; an empty list disables the button.
  const visibleUnreadIds = useMemo(() => {
    const ids: string[] = [];
    for (const item of visible) {
      if (item.unread) ids.push(item.id);
    }
    return ids;
  }, [visible]);

  // Detail-pane reader: when a row is selected, swap the list out. The
  // reader gets its own fetch (`useInboxDetail`), so the list-level filter
  // / pagination state stays put while the user reads.
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
      <div className="vs-card-in px-2 py-4">
        <p className="text-[12px] leading-5 text-white/65">
          Connect Gmail to see your latest unread threads here.
        </p>
      </div>
    );
  }

  return (
    <div className="vs-card-in space-y-2">
      <SearchBar
        value={query}
        onChange={(next) => {
          setQuery(next);
          if (!serverPaginated) setLocalPage(0);
        }}
      />

      <div className="px-1 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => {
            setUnreadOnly((v) => !v);
            if (!serverPaginated) setLocalPage(0);
          }}
          aria-pressed={unreadOnly}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 -mx-1.5",
            "text-[10.5px] uppercase tracking-tight font-medium transition-colors",
            "outline-none focus-visible:ring-2 focus-visible:ring-white/40",
            unreadOnly ? "bg-vs-purple-4/20 text-vs-purple-4" : "text-white/60 hover:text-white/85",
          )}
        >
          <span
            aria-hidden
            className={cn("size-1.5 rounded-full", unreadOnly ? "bg-vs-purple-4" : "bg-white/55")}
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
                "text-[11px] text-white/65 hover:text-white transition-colors",
                "outline-none focus-visible:ring-2 focus-visible:ring-white/40 rounded",
                "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-white/65",
              )}
            >
              Mark all read
            </button>
          ) : null}
        </div>
      </div>

      {items.length === 0 && pagination?.isLoading ? (
        // Page hasn't landed in the cache yet (typically: user clicked
        // "Next" before the fetch resolved). Show a loader rather than the
        // "No matches" empty state, which would otherwise flash for one
        // render window and read as a filter result instead of in-flight
        // pagination.
        <div className="px-2 py-6 flex items-center justify-center">
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

function filterMatches(item: InboxItem, query: string, unreadOnly: boolean): boolean {
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
  isLoading?: boolean;
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
      <span className="text-[10.5px] tabular-nums text-white/70 px-1 min-w-[28px] text-center inline-flex items-center justify-center gap-1">
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
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "size-6 inline-flex items-center justify-center rounded-md",
        "transition-colors vs-press",
        "text-white/70 hover:bg-white/10 hover:text-white",
        "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-white/70",
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
        "flex items-center gap-1.5 px-2 py-1.5 -mx-0.5 rounded-lg",
        // White-alpha treatment so the field reads against the rail's
        // video surface. Brighter ring at rest, near-white on focus —
        // the vs-purple-2 ring is too dim to register on the cloudy
        // backdrop.
        "bg-white/[0.06] ring-1 ring-inset ring-white/15",
        "focus-within:bg-white/[0.10] focus-within:ring-white/45",
        "transition-[background-color,box-shadow]",
      )}
    >
      <Search size={12} className="text-white/55 shrink-0" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Filter inbox"
        aria-label="Filter inbox"
        className={cn(
          "flex-1 min-w-0 bg-transparent text-[12px] leading-5 text-white placeholder:text-white/55",
          "outline-none",
        )}
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear filter"
          className="text-white/55 hover:text-white transition-colors shrink-0"
        >
          <X size={12} />
        </button>
      ) : null}
    </div>
  );
}

function InboxRow({ item, onOpen }: { item: InboxItem; onOpen?: (documentId: string) => void }) {
  const href = item.threadId
    ? `https://mail.google.com/mail/u/0/#inbox/${item.threadId}`
    : undefined;
  // Render priority: `onOpen` (in-rail reader) → anchor (Gmail web)
  // → static container. A focusable element with no handler would lie
  // to keyboard users about the row being actionable.
  const interactive = !!onOpen || !!href;
  const sharedClass = cn(
    "group relative w-full text-left rounded-xl px-2 py-2 -mx-0.5",
    "flex items-start gap-2.5",
    interactive
      ? cn(
          "hover:bg-white/[0.07] transition-colors vs-press",
          "outline-none focus-visible:ring-2 focus-visible:ring-white/40",
        )
      : "cursor-default",
  );

  const body = (
    <>
      {/* Unread accent — sits along the left edge of the row so the
       * "this needs attention" signal reads even when the user is
       * scanning the rail peripherally. Falls back to a transparent
       * stripe for read rows so the layout doesn't shift. */}
      <span
        aria-hidden
        className={cn(
          "absolute left-0 top-2 bottom-2 w-[2px] rounded-full transition-colors",
          item.unread ? "bg-vs-purple-4" : "bg-transparent",
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
          <span className="ml-auto shrink-0 inline-flex items-center gap-1.5">
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

function SenderAvatar({ item }: { item: InboxItem }) {
  // First-class brand SVG wins — these are hand-tuned to look right on
  // the rail surface (correct color, correct optical centering).
  if (item.senderBrand) {
    return (
      <span
        aria-hidden
        className={cn(
          "mt-0.5 size-7 shrink-0 rounded-full inline-flex items-center justify-center",
          "bg-white/10 ring-1 ring-inset ring-white/15",
        )}
      >
        <IntegrationGlyph brand={item.senderBrand} size={16} />
      </span>
    );
  }
  // Favicon fallback for unmapped corporate / transactional domains.
  // Hide-on-error reveals the colored initial sitting behind the img,
  // so a 404'd favicon degrades cleanly to the existing avatar.
  if (item.senderDomain) {
    return (
      <span
        aria-hidden
        className={cn(
          "relative mt-0.5 size-7 shrink-0 rounded-full inline-flex items-center justify-center",
          "text-[11px] font-semibold tabular-nums overflow-hidden",
          TOOL_TONE[item.tone],
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
            "bg-white/85 dark:bg-white/90 p-[1px]",
          )}
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "mt-0.5 size-7 shrink-0 rounded-full inline-flex items-center justify-center",
        "text-[11px] font-semibold tabular-nums",
        TOOL_TONE[item.tone],
      )}
    >
      {item.initial}
    </span>
  );
}

/**
 * Compact triage chip. Categories share four buckets visually:
 *  - red    — `urgent`
 *  - amber  — `action_needed`, `awaiting_reply`, `payment`
 *  - sky    — `follow_up`, `meeting`
 *  - green  — `done`
 *  - gray   — `fyi`, `newsletter`, `marketing`
 */
function CategoryChip({
  category,
  source,
  onChange,
}: {
  category: TriageCategory;
  source?: TriageTagSource | null;
  onChange?: (category: TriageCategory) => void;
}) {
  const chipClass = cn(
    "inline-flex items-center rounded-md px-1.5 h-4",
    "text-[10px] font-medium uppercase tracking-tight whitespace-nowrap",
    source === "user" && "gap-1 ring-1 ring-inset ring-current/25",
    CATEGORY_CHIP[category],
  );
  const contents = (
    <>
      {source === "user" ? <Tag size={9} aria-hidden /> : null}
      {TRIAGE_DISPLAY[category]}
    </>
  );

  if (!onChange) {
    return (
      <span className={chipClass} title={source === "user" ? "User override" : undefined}>
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
            "before:absolute before:-inset-3 before:content-['']",
            "outline-none focus-visible:ring-2 focus-visible:ring-white/40",
          )}
          aria-label={`Change triage tag, currently ${TRIAGE_DISPLAY[category]}`}
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
            "bg-vs-bg-1/95 text-vs-fg-4 shadow-xl ring-1 ring-white/15 backdrop-blur",
          )}
        >
          {TRIAGE_CATEGORIES.map((option) => (
            <DropdownMenuPrimitive.Item
              key={option}
              onSelect={() => onChange(option)}
              className={cn(
                "flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2",
                "text-[12px] outline-none data-[highlighted]:bg-white/10",
              )}
            >
              <span aria-hidden className={cn("size-2 rounded-full", CATEGORY_SWATCH[option])} />
              <span className="min-w-0 flex-1 truncate">{TRIAGE_DISPLAY[option]}</span>
              {option === category ? <Check size={12} className="text-vs-fg-3" aria-hidden /> : null}
            </DropdownMenuPrimitive.Item>
          ))}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

const CATEGORY_CHIP: Record<TriageCategory, string> = {
  urgent: "bg-vs-red-1 text-vs-red-4",
  action_needed: "bg-vs-amber-1 text-vs-amber-4",
  awaiting_reply: "bg-vs-amber-1 text-vs-amber-4",
  payment: "bg-vs-amber-1 text-vs-amber-4",
  follow_up: "bg-vs-sky-1 text-vs-sky-4",
  meeting: "bg-vs-sky-1 text-vs-sky-4",
  fyi: "bg-vs-bg-a2 text-vs-fg-2",
  done: "bg-vs-green-1 text-vs-green-4",
  newsletter: "bg-vs-bg-a2 text-vs-fg-2",
  marketing: "bg-vs-bg-a2 text-vs-fg-2",
};

const CATEGORY_SWATCH: Record<TriageCategory, string> = {
  urgent: "bg-vs-red-4",
  action_needed: "bg-vs-amber-4",
  awaiting_reply: "bg-vs-amber-4",
  payment: "bg-vs-amber-4",
  follow_up: "bg-vs-sky-4",
  meeting: "bg-vs-sky-4",
  fyi: "bg-vs-fg-2",
  done: "bg-vs-green-4",
  newsletter: "bg-vs-fg-2",
  marketing: "bg-vs-fg-2",
};

/**
 * Thread reader. Replaces the list view when a row is selected; renders
 * every Gmail message sharing the row's `threadId` as a stacked timeline,
 * oldest-first. The clicked message gets a subtle ring so the user can
 * find it after the fan-out.
 *
 * Each message exposes a Reader (markdown) / Original (sandboxed iframe
 * with the sanitized HTML) toggle so transactional mail can render with
 * its own CSS while newsletters fall back to a clean text view.
 *
 * Reply editor is intentionally deferred — dimension ships a Tiptap-based
 * inline composer (CatchupGmailItem), but Alfred doesn't yet have a send
 * API for the rail. Adding the editor without `sendReply` is a UI lie,
 * so v1 just reads.
 */
function InboxDetailPane({
  documentId,
  onClose,
  triageTagsByThreadId,
  onOverrideTag,
}: {
  documentId: string;
  onClose: () => void;
  triageTagsByThreadId?: ReadonlyMap<string, SyncedTriageTag>;
  onOverrideTag?: (threadId: string, category: TriageCategory) => void;
}) {
  const { data, isLoading, isError } = useInboxDetail(documentId);
  const threadId = data?.threadId ?? null;
  const syncedTag = threadId ? triageTagsByThreadId?.get(threadId) : undefined;
  const displayedCategory = syncedTag?.category ?? data?.category ?? null;
  const displayedSource = syncedTag?.source ?? null;
  const changeCategory =
    threadId && onOverrideTag
      ? (category: TriageCategory) => onOverrideTag(threadId, category)
      : undefined;

  return (
    <div className="vs-card-in flex flex-col gap-3 px-1">
      <div className="flex items-center justify-between gap-2 px-1">
        <button
          type="button"
          onClick={onClose}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 -mx-1.5",
            "text-[11px] uppercase tracking-tight font-medium text-vs-fg-3",
            "transition-colors hover:text-vs-fg-4 hover:bg-vs-bg-a2",
            "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2",
            "focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
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
              "inline-flex items-center gap-1 text-[11px] text-vs-fg-3",
              "transition-colors hover:text-vs-fg-4",
              "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2",
              "focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
              "rounded-md px-1.5 py-1 -mx-1.5",
            )}
          >
            Open in Gmail
            <ExternalLink size={11} />
          </a>
        ) : null}
      </div>

      {isLoading ? (
        <div className="px-2 py-8 flex items-center justify-center">
          <Loader2 size={16} className="animate-spin text-vs-fg-3" aria-hidden />
        </div>
      ) : isError || !data ? (
        <div className="px-2 py-6 text-center">
          <p className="text-[12px] text-vs-fg-2">Couldn't load this email.</p>
        </div>
      ) : (
        <article className="space-y-3 px-1">
          <header className="space-y-1.5">
            <h3 className="text-[14px] leading-5 font-medium text-vs-fg-4 break-words">
              {data.subject || "(no subject)"}
            </h3>
            <div className="flex items-center gap-2 flex-wrap">
              {displayedCategory ? (
                <CategoryChip
                  category={displayedCategory}
                  source={displayedSource}
                  onChange={changeCategory}
                />
              ) : null}
              <span className="text-[11px] tabular-nums text-vs-fg-2">
                {data.messages.length} message
                {data.messages.length === 1 ? "" : "s"}
              </span>
            </div>
          </header>
          {data.messages.length === 0 ? (
            <p className="text-[12px] text-vs-fg-2 px-1">(no messages)</p>
          ) : (
            <ol className="space-y-2.5">
              {data.messages.map((m, i) => (
                <li key={m.documentId}>
                  <ThreadMessageCard
                    message={m}
                    isSelected={m.documentId === data.selectedDocumentId}
                    threadId={data.threadId}
                    /* Auto-expand the last message in the thread + the
                     * clicked one. Earlier messages collapse to a single
                     * header row so long threads don't overwhelm the rail. */
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
 * One message in the thread timeline.
 *
 * Collapsed: a single tappable row with avatar + sender + relative time
 * + a one-line snippet. Cheap to scan; matches Gmail's collapsed reply
 * shape.
 *
 * Expanded: full header, view toggle (Reader / Original), markdown or
 * iframe body, attachment strip. The toggle is per-message so a thread
 * can mix views — useful when one reply quotes an HTML newsletter and
 * the others are plain prose.
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
  // Default to Reader; users can flip to Original per-message. The parent
  // keys this card by documentId, so a different message remounts with fresh
  // state — no manual reset needed.
  const [view, setView] = useState<"reader" | "original">("reader");

  const hasHtml = !!message.htmlBody;

  const summary = useMemo(
    () => buildSnippet(message.snippet, message.body),
    [message.snippet, message.body],
  );

  return (
    <div
      className={cn(
        "rounded-xl bg-vs-bg-a2/60 ring-1 ring-vs-bg-3/40",
        "transition-shadow",
        isSelected && "ring-2 ring-vs-purple-2",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "w-full text-left flex items-start gap-2 px-2.5 py-2 rounded-xl",
          "transition-colors hover:bg-vs-bg-a2",
          "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2",
          "focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
        )}
        aria-expanded={open}
      >
        <SenderInitialAvatar name={message.senderDisplay} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 truncate text-[12.5px] font-medium text-vs-fg-4">
              {message.senderDisplay}
            </span>
            {message.authoredAtRelative ? (
              <span className="ml-auto shrink-0 text-[11px] tabular-nums text-vs-fg-2">
                {message.authoredAtRelative}
              </span>
            ) : null}
          </span>
          {!open && summary ? (
            <span className="block truncate text-[11.5px] text-vs-fg-2 mt-0.5">{summary}</span>
          ) : null}
          {open && message.senderEmail ? (
            <span className="block truncate text-[11px] text-vs-fg-2 mt-0.5">
              {message.senderEmail}
            </span>
          ) : null}
        </span>
      </button>

      {open ? (
        <div className="px-2.5 pb-2.5 space-y-2">
          {hasHtml ? <ViewToggle value={view} onChange={setView} /> : null}
          <div className="rounded-lg bg-vs-bg-1/40 ring-1 ring-vs-bg-3/30 overflow-hidden">
            {view === "original" && message.htmlBody ? (
              <EmailHtmlFrame html={message.htmlBody} />
            ) : message.body.trim() ? (
              <div className="px-3 py-2.5">
                <MarkdownRenderer>{message.body.trim()}</MarkdownRenderer>
              </div>
            ) : (
              <p className="px-3 py-2.5 text-[12px] italic text-vs-fg-2">(empty body)</p>
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

/**
 * Build a short preview from the message body when Gmail didn't supply a
 * snippet (or supplied one full of HTML entities). The collapsed message
 * row uses this to give the user something to scan before expanding.
 */
function buildSnippet(snippet: string | null, body: string): string {
  const s = (snippet ?? "").trim();
  if (s) return s;
  // Strip leading "On Mon, … wrote:" attribution lines and obvious
  // signatures so the snippet shows the actual reply content.
  const firstLine = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !/^>/.test(l) && !/^on .+wrote:/i.test(l));
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
    <fieldset className="inline-flex items-center gap-0 rounded-md border-0 bg-vs-bg-a2 ring-1 ring-vs-bg-3/40 p-0.5 text-[10.5px] uppercase tracking-tight font-medium">
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
        "rounded px-1.5 py-0.5 transition-colors vs-press",
        "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2",
        "focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
        active ? "bg-vs-bg-1 text-vs-fg-4" : "text-vs-fg-2 hover:text-vs-fg-3",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Renders email HTML in a sandboxed iframe via `srcDoc`. DOMPurify already
 * scrubbed dangerous markup server-side; the sandbox is defense-in-depth.
 *
 * Sandbox includes `allow-same-origin` but NOT `allow-scripts` — that pairing
 * is required for the parent to read `contentDocument.body.scrollHeight`
 * (without `allow-same-origin` the srcdoc document gets an opaque origin
 * and the read is blocked), and it stays safe because no scripts can run
 * to exploit the same-origin access. Auto-sizes on `load` + `ResizeObserver`.
 */
function EmailHtmlFrame({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(200);

  useLayoutEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let cancelled = false;
    let observer: ResizeObserver | null = null;

    const measure = () => {
      if (cancelled) return;
      const doc = frame.contentDocument;
      if (!doc?.body) return;
      // `scrollHeight` on body misses bottom margin on some emails;
      // documentElement covers both. Cap at a generous max so a runaway
      // email can't blow up the rail layout.
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
    // Some browsers fire load before the listener attaches when the
    // document was already populated synchronously by srcDoc — measure now.
    if (frame.contentDocument?.readyState === "complete") onLoad();

    return () => {
      cancelled = true;
      frame.removeEventListener("load", onLoad);
      observer?.disconnect();
    };
  }, [html]);

  return (
    <iframe
      ref={ref}
      title="Email body"
      srcDoc={html}
      // `allow-same-origin` without `allow-scripts` lets us measure
      // `contentDocument` from the parent while still blocking JS execution
      // inside the frame. `allow-popups` (and -to-escape-sandbox) lets the
      // `<base target="_blank">` we injected open links in a new tab.
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      // referrerpolicy keeps clicked links from leaking the chat URL.
      referrerPolicy="no-referrer"
      className="block w-full bg-white"
      style={{ height, border: 0, colorScheme: "light" }}
    />
  );
}

/**
 * Two-letter monogram avatar for thread message cards. Reuses the same
 * deterministic-tone mapping as the inbox list rows so a sender keeps
 * the same color across surfaces.
 */
function SenderInitialAvatar({ name }: { name: string }) {
  const tone = useMemo(() => toneFromName(name), [name]);
  const initial = (name.trim().charAt(0) || "?").toUpperCase();
  return (
    <span
      aria-hidden
      className={cn(
        "mt-0.5 size-6 shrink-0 rounded-full inline-flex items-center justify-center",
        "text-[10.5px] font-semibold",
        tone,
      )}
    >
      {initial}
    </span>
  );
}

const TONE_CLASSES = [
  "bg-vs-purple-1 text-vs-purple-4",
  "bg-vs-sky-1 text-vs-sky-4",
  "bg-vs-amber-1 text-vs-amber-4",
  "bg-vs-green-1 text-vs-green-4",
  "bg-vs-red-1 text-vs-red-4",
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

/**
 * Compact attachment row. Gmail's attachment-download endpoint requires the
 * opaque `attachmentId` plus an OAuth token — we don't ship that to the
 * browser, so each chip just deep-links into Gmail web. The thread URL is
 * the closest stable target (Gmail doesn't surface per-attachment anchors).
 */
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
        <Paperclip size={11} className="text-vs-fg-2" aria-hidden />
        <span className="text-[10.5px] uppercase tracking-tight font-medium text-vs-fg-2">
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
          "shrink-0 inline-flex items-center justify-center",
          "size-8 rounded-md",
          tone,
        )}
      >
        <Icon size={14} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] leading-4 font-medium text-vs-fg-4">
          {attachment.filename}
        </span>
        <span className="block text-[11px] leading-4 text-vs-fg-2 tabular-nums">
          {formatBytes(attachment.size)}
          {attachment.mimeType ? (
            <>
              <span aria-hidden className="mx-1 opacity-60">
                ·
              </span>
              <span className="uppercase tracking-tight">
                {extensionFor(attachment.filename, attachment.mimeType)}
              </span>
            </>
          ) : null}
        </span>
      </span>
      {href ? <ExternalLink size={12} className="shrink-0 text-vs-fg-2" aria-hidden /> : null}
    </>
  );
  const shared = cn(
    "group flex items-center gap-2.5 rounded-lg px-2 py-1.5",
    "ring-1 ring-vs-bg-3/40 bg-vs-bg-a2/60",
    href
      ? cn(
          "transition-colors hover:bg-vs-bg-a2 hover:ring-vs-bg-3/70",
          "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2",
          "focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
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

/**
 * Pick an icon + tone for an attachment based on its mime type. Falls back
 * to the filename extension when the mime is the generic
 * `application/octet-stream` (common from forwarded mails).
 */
function attachmentVisual(
  mimeType: string,
  filename: string,
): { tone: string; icon: typeof FileIcon } {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const mime = mimeType.toLowerCase();
  if (mime.startsWith("image/")) {
    return { tone: "bg-vs-purple-1 text-vs-purple-4", icon: ImageIcon };
  }
  if (mime.startsWith("video/")) {
    return { tone: "bg-vs-sky-1 text-vs-sky-4", icon: Film };
  }
  if (mime.startsWith("audio/")) {
    return { tone: "bg-vs-sky-1 text-vs-sky-4", icon: Music };
  }
  if (mime === "application/pdf" || ext === "pdf") {
    return { tone: "bg-vs-red-1 text-vs-red-4", icon: FileText };
  }
  if (
    mime.includes("spreadsheet") ||
    mime === "text/csv" ||
    ext === "csv" ||
    ext === "xlsx" ||
    ext === "xls"
  ) {
    return { tone: "bg-vs-green-1 text-vs-green-4", icon: FileSpreadsheet };
  }
  if (
    mime.includes("word") ||
    mime === "text/plain" ||
    ext === "doc" ||
    ext === "docx" ||
    ext === "txt" ||
    ext === "md"
  ) {
    return { tone: "bg-vs-amber-1 text-vs-amber-4", icon: FileText };
  }
  return { tone: "bg-vs-bg-a2 text-vs-fg-3", icon: FileIcon };
}

function extensionFor(filename: string, mimeType: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (ext && ext.length <= 5 && ext !== filename.toLowerCase()) return ext;
  // Map a few common mime types to a readable label when the filename
  // doesn't carry an extension (e.g. `attachment` with `image/png`).
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
