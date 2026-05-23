import { cn } from "~/lib/utils";
import { INBOX, TOOL_TONE, type InboxItem } from "./helpers";

export function InboxFeed() {
  const unread = INBOX.filter((i) => i.unread).length;
  return (
    <div className="vs-card-in space-y-2">
      <div className="px-1 flex items-center justify-between">
        <span className="text-[10.5px] uppercase tracking-tight font-medium text-vs-fg-2">
          Unread · {unread}
        </span>
        <button
          type="button"
          className="text-[11px] text-vs-fg-3 hover:text-vs-fg-4 transition-colors"
        >
          Mark all read
        </button>
      </div>
      <ul className="space-y-0.5">
        {INBOX.map((item) => (
          <InboxRow key={item.id} item={item} />
        ))}
      </ul>
    </div>
  );
}

function InboxRow({ item }: { item: InboxItem }) {
  return (
    <li>
      <button
        type="button"
        className={cn(
          "group w-full text-left rounded-xl px-2 py-2 -mx-0.5",
          "hover:bg-vs-bg-a2 transition-colors vs-press",
          "flex items-start gap-2.5",
          "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-background",
        )}
      >
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
            {item.unread ? (
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-vs-purple-4" />
            ) : null}
            <span className="ml-auto shrink-0 text-[11px] text-vs-fg-2 tabular-nums">
              {item.time}
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
          <span className="block truncate text-[11px] leading-4 text-vs-fg-2">
            {item.preview}
          </span>
        </span>
      </button>
    </li>
  );
}
