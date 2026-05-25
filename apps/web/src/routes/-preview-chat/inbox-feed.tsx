import { TRIAGE_DISPLAY, type TriageCategory } from "@alfred/contracts";
import { Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { IntegrationGlyph } from "~/lib/integration-icons";
import { cn } from "~/lib/utils";
import { TOOL_TONE, type InboxItem } from "./helpers";

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
export function InboxFeed({ items }: { items: ReadonlyArray<InboxItem> }) {
  const [query, setQuery] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);

  const totalUnread = items.filter((i) => i.unread).length;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((item) => {
      if (unreadOnly && !item.unread) return false;
      if (!q) return true;
      return (
        item.sender.toLowerCase().includes(q) ||
        item.subject.toLowerCase().includes(q) ||
        item.preview.toLowerCase().includes(q)
      );
    });
  }, [items, query, unreadOnly]);

  if (!items.length) {
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
      <SearchBar value={query} onChange={setQuery} />

      <div className="px-1 flex items-center justify-between">
        <button
          type="button"
          onClick={() => setUnreadOnly((v) => !v)}
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
        <button
          type="button"
          className="text-[11px] text-vs-fg-3 hover:text-vs-fg-4 transition-colors"
        >
          Mark all read
        </button>
      </div>

      {filtered.length === 0 ? (
        <div className="px-2 py-6 text-center">
          <p className="text-[12px] text-vs-fg-2">No matches.</p>
        </div>
      ) : (
        <ul className="space-y-0.5">
          {filtered.map((item) => (
            <InboxRow key={item.id} item={item} />
          ))}
        </ul>
      )}
    </div>
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

function InboxRow({ item }: { item: InboxItem }) {
  const href = item.threadId
    ? `https://mail.google.com/mail/u/0/#inbox/${item.threadId}`
    : undefined;
  // Render as an anchor when we have a thread to open, otherwise a
  // plain non-interactive container — a focusable element with no
  // handler would lie to keyboard users about the row being actionable.
  const sharedClass = cn(
    "group relative w-full text-left rounded-xl px-2 py-2 -mx-0.5",
    "flex items-start gap-2.5",
    href
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
      {href ? (
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
