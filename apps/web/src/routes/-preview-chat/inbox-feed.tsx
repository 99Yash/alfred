import { TRIAGE_DISPLAY, type TriageCategory } from "@alfred/contracts";
import { ArrowLeft, ChevronLeft, ChevronRight, ExternalLink, Loader2, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useInboxDetail } from "~/hooks/use-inbox";
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
}

export function InboxFeed({ items, pagination, selectedId, onOpen, onClose }: InboxFeedProps) {
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

  // Detail-pane reader: when a row is selected, swap the list out. The
  // reader gets its own fetch (`useInboxDetail`), so the list-level filter
  // / pagination state stays put while the user reads.
  if (selectedId && onClose) {
    return <InboxDetailPane documentId={selectedId} onClose={onClose} />;
  }

  if (!items.length && (!pagination || pagination.total === 0)) {
    return (
      <div className="vs-card-in px-2 py-4">
        <p className="text-[12px] leading-5 text-vs-fg-2">
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
            "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
            unreadOnly
              ? "bg-vs-purple-1 text-vs-purple-4"
              : "text-vs-fg-2 hover:text-vs-fg-3",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "size-1.5 rounded-full",
              unreadOnly ? "bg-vs-purple-4" : "bg-vs-fg-2",
            )}
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
          <button
            type="button"
            className="text-[11px] text-vs-fg-3 hover:text-vs-fg-4 transition-colors"
          >
            Mark all read
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="px-2 py-6 text-center">
          <p className="text-[12px] text-vs-fg-2">No matches.</p>
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
      <span className="text-[10.5px] tabular-nums text-vs-fg-3 px-1 min-w-[28px] text-center inline-flex items-center justify-center gap-1">
        {isLoading ? (
          <Loader2 size={10} className="animate-spin text-vs-fg-3" aria-hidden />
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
        "text-vs-fg-3 hover:bg-vs-bg-a2 hover:text-vs-fg-4",
        "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-vs-fg-3",
        "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
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
        "bg-vs-bg-a2 ring-1 ring-vs-bg-3/60",
        "focus-within:ring-vs-purple-2 transition-shadow",
      )}
    >
      <Search size={12} className="text-vs-fg-2 shrink-0" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Filter inbox"
        aria-label="Filter inbox"
        className={cn(
          "flex-1 min-w-0 bg-transparent text-[12px] leading-5 text-vs-fg-4 placeholder:text-vs-fg-2",
          "outline-none",
        )}
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear filter"
          className="text-vs-fg-2 hover:text-vs-fg-4 transition-colors shrink-0"
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
  item: InboxItem;
  onOpen?: (documentId: string) => void;
}) {
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
          "hover:bg-vs-bg-a2 transition-colors vs-press",
          "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2",
          "focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
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
              item.unread ? "font-medium text-vs-fg-4" : "text-vs-fg-3",
            )}
          >
            {item.sender}
          </span>
          <span className="ml-auto shrink-0 inline-flex items-center gap-1.5">
            {item.category ? <CategoryChip category={item.category} /> : null}
            <span className="text-[11px] text-vs-fg-2 tabular-nums">{item.time}</span>
          </span>
        </span>
        <span
          className={cn(
            "block truncate text-[12px] leading-4",
            item.unread ? "text-vs-fg-3" : "text-vs-fg-2",
          )}
        >
          {item.subject}
        </span>
        <span
          className={cn(
            "block truncate text-[11px] leading-4",
            item.unread ? "text-vs-fg-2" : "text-vs-fg-2/70",
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
          "bg-vs-bg-2 ring-1 ring-vs-bg-3/60",
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
function CategoryChip({ category }: { category: TriageCategory }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-1.5 h-4",
        "text-[10px] font-medium uppercase tracking-tight whitespace-nowrap",
        CATEGORY_CHIP[category],
      )}
    >
      {TRIAGE_DISPLAY[category]}
    </span>
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

/**
 * Single-email reader. Replaces the list view when a row is selected.
 * Renders the row's full plain-text body (server-side header strip already
 * applied) with a back button and an Open-in-Gmail deep link.
 *
 * Reply editor is intentionally deferred — dimension ships a Tiptap-based
 * inline composer (CatchupGmailItem), but Alfred doesn't yet have a send
 * API for the rail. Adding the editor without `sendReply` is a UI lie,
 * so v1 just reads.
 */
function InboxDetailPane({
  documentId,
  onClose,
}: {
  documentId: string;
  onClose: () => void;
}) {
  const { data, isLoading, isError } = useInboxDetail(documentId);

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
            <h3 className="text-[14px] leading-5 font-medium text-vs-fg-4">
              {data.subject || "(no subject)"}
            </h3>
            <div className="flex items-baseline gap-2">
              <span className="text-[12px] font-medium text-vs-fg-3 truncate">
                {data.senderDisplay}
              </span>
              {data.authoredAtRelative ? (
                <span className="text-[11px] tabular-nums text-vs-fg-2 shrink-0">
                  {data.authoredAtRelative}
                </span>
              ) : null}
            </div>
            {data.senderEmail ? (
              <p className="text-[11px] text-vs-fg-2 truncate">{data.senderEmail}</p>
            ) : null}
            {data.category ? (
              <CategoryChip category={data.category} />
            ) : null}
          </header>
          <div
            className={cn(
              "rounded-lg bg-vs-bg-a2 px-3 py-2.5",
              "text-[12px] leading-[1.55] text-vs-fg-3 whitespace-pre-wrap break-words",
            )}
          >
            {data.body.trim() || "(empty body)"}
          </div>
        </article>
      )}
    </div>
  );
}
