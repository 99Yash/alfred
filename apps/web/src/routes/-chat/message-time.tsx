import { formatDateTime } from "~/lib/strings";
import { cn } from "~/lib/utils";
import { Tip } from "./tip";

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * "3:42 PM" today, "Yesterday 3:42 PM", "Oct 21, 3:42 PM" this year, then "Oct 21, 2025, 3:42 PM".
 * Without the year, a message from a year ago reads as this year's. The browser's zone, like the rest of the feed.
 */
function shortStamp(date: Date, now: Date): string {
  const clock = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  if (sameDay(date, now)) return clock;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  if (sameDay(date, yesterday)) return `Yesterday ${clock}`;

  if (date.getFullYear() === now.getFullYear()) return formatDateTime(date.toISOString());

  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * A message's send time. Hidden until the reader hovers or keyboard-focuses the message group,
 * so the caller passes the group's reveal classes. The tip shows the full date.
 * Opacity, not display: the row keeps its size, so a hover never re-measures the feed.
 */
export function MessageTime({ iso, revealClassName }: { iso: string; revealClassName: string }) {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) return null;

  const full = date.toLocaleString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });

  return (
    <Tip label={full}>
      <time
        dateTime={iso}
        className={cn(
          "shrink-0 text-[11px] leading-none whitespace-nowrap text-app-fg-2 tabular-nums select-none",
          "opacity-0 transition-opacity duration-150 ease-out pointer-coarse:opacity-100",
          revealClassName,
        )}
      >
        {shortStamp(date, new Date())}
      </time>
    </Tip>
  );
}
