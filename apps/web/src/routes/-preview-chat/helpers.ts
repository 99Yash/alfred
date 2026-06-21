import type { AttentionBand, TriageCategory, TriageTagSource } from "@alfred/contracts";
import { useEffect, useState } from "react";
import type { IntegrationBrand } from "~/lib/integrations/integration-icons";

export type ThreadGroup = "today" | "yesterday" | "earlier";

export interface ThreadEntry {
  id: string;
  title: string;
  preview: string;
  pinned?: boolean;
  unread?: boolean;
}

export const THREADS: Record<ThreadGroup, ThreadEntry[]> = {
  today: [
    {
      id: "morning-brief",
      title: "Morning briefing — Friday",
      preview: "Three threads to look at, calendar starts at 10.",
      pinned: true,
    },
    {
      id: "sycamore-recap",
      title: "Sycamore investor update",
      preview: "Pull last three sends and summarize the asks.",
    },
    {
      id: "calendar-block",
      title: "Block focus time tomorrow",
      preview: "Two free 90-min windows on the calendar.",
      unread: true,
    },
  ],
  yesterday: [
    {
      id: "triage-rules",
      title: "Tune triage label rules",
      preview: "Move newsletters off the inbox tab.",
    },
    {
      id: "vesting-q",
      title: "Vesting cliff question",
      preview: "Draft response to Maya's email.",
    },
  ],
  earlier: [
    {
      id: "weekly-recap",
      title: "Weekly recap — week 21",
      preview: "Highlights, blockers, decisions made.",
    },
    {
      id: "cold-start",
      title: "Cold-start research notes",
      preview: "Pull facts from initial Sonar pass.",
    },
    {
      id: "memory-cleanup",
      title: "Memory cleanup pass",
      preview: "Remove stale auth-flow notes.",
    },
  ],
};

export type RailMode = "inline" | "overlay";
export type RailTab = "todo" | "inbox" | "meetings";

const RAIL_BREAKPOINT = "(min-width: 1280px)";

export function useRailMode(): RailMode {
  const [mode, setMode] = useState<RailMode>(() => {
    if (typeof window === "undefined") return "inline";
    return window.matchMedia(RAIL_BREAKPOINT).matches ? "inline" : "overlay";
  });
  useEffect(() => {
    const mq = window.matchMedia(RAIL_BREAKPOINT);
    const handler = () => setMode(mq.matches ? "inline" : "overlay");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return mode;
}

export interface TodoItem {
  id: string;
  title: string;
  due?: string;
  source?: "email" | "meeting" | "manual";
  done?: boolean;
}

export const TODOS: TodoItem[] = [
  {
    id: "maya-reply",
    title: "Reply to Maya — vesting cliff question",
    due: "Today",
    source: "email",
  },
  {
    id: "sycamore-recap",
    title: "Send Sycamore investor recap",
    due: "Today",
    source: "email",
  },
  {
    id: "linear-renewal",
    title: "Decide on Linear vendor renewal",
    due: "Tomorrow",
  },
  {
    id: "focus-friday",
    title: "Block focus time Friday",
    source: "meeting",
  },
  {
    id: "fatca",
    title: "Submit FATCA/CRS forms",
    due: "May 26",
    done: true,
  },
];

export interface InboxItem {
  id: string;
  sender: string;
  /**
   * Bare sender email (`local@domain`), for the attention scorer's bulk-sender
   * detection + recurrence grouping. {@link InboxItem.sender} is a display name
   * and can't reveal a `no-reply@`/`notifications@` mailbox. Null when unparseable.
   */
  senderAddress?: string | null;
  subject: string;
  preview: string;
  time: string;
  /**
   * Authored time as epoch ms — the chronological key the attention scorer uses
   * to order recurrence (the rail renders newest-first, but the Nth repeat must
   * decay oldest-first). Null when the row carries no authored timestamp.
   * Distinct from {@link InboxItem.time}, which is a localized display string.
   */
  authoredAtMs?: number | null;
  unread?: boolean;
  initial: string;
  tone: ToolTone;
  /** Gmail thread id — used to deep-link rows to Gmail web. */
  threadId?: string | null;
  /** Triage category surfaced as a chip next to the timestamp. */
  category?: TriageCategory | null;
  /** Whether the visible triage tag came from the classifier or a user override. */
  categorySource?: TriageTagSource | null;
  /**
   * Presentation-layer demand band (ADR-0064 / #210), computed across the
   * visible list from category + sender significance + cross-row recurrence.
   * Drives row ordering and de-emphasis — `muted` rows dim, `demanding` lead.
   * Never re-tags: the honest {@link InboxItem.category} chip is unchanged.
   */
  attentionBand?: AttentionBand | null;
  /** Brand glyph for noreply senders (github, linkedin, linear, …). */
  senderBrand?: IntegrationBrand | null;
  /**
   * Domain of the sender's email (e.g. `notion.so`). Used for the favicon
   * fallback avatar when the domain doesn't have a first-class brand SVG.
   */
  senderDomain?: string | null;
}

export const INBOX: InboxItem[] = [
  {
    id: "maya",
    sender: "Maya Chen",
    subject: "Re: vesting cliff",
    preview: "Quick question on the 4-yr — does the…",
    time: "8m",
    unread: true,
    initial: "M",
    tone: "purple",
  },
  {
    id: "sycamore",
    sender: "Sycamore Capital",
    subject: "Quarterly investor update",
    preview: "Hi team — wanted to check in on the…",
    time: "1h",
    unread: true,
    initial: "S",
    tone: "sky",
  },
  {
    id: "linear",
    sender: "Linear",
    subject: "Renewal notice",
    preview: "Your team plan renews on June 14…",
    time: "3h",
    initial: "L",
    tone: "amber",
  },
  {
    id: "github",
    sender: "GitHub",
    subject: "3 PRs need your review",
    preview: "alfred/m13-agent-bridge-followup…",
    time: "5h",
    initial: "G",
    tone: "green",
  },
];

export interface MeetingItem {
  id: string;
  title: string;
  time: string;
  duration: string;
  with: string;
  status?: "now" | "next" | "later";
}

export const MEETINGS: MeetingItem[] = [
  {
    id: "eng-sync",
    title: "Eng sync",
    time: "10:00",
    duration: "30m",
    with: "5 people",
    status: "next",
  },
  {
    id: "priya",
    title: "1:1 with Priya",
    time: "11:30",
    duration: "30m",
    with: "Priya R.",
  },
  {
    id: "sycamore-call",
    title: "Sycamore investor call",
    time: "14:00",
    duration: "45m",
    with: "3 people",
  },
];

export type ToolTone = "sky" | "amber" | "purple" | "green" | "pink" | "orange";

export const TOOL_TONE: Record<ToolTone, string> = {
  sky: "bg-app-sky-1 text-app-sky-4",
  amber: "bg-app-amber-1 text-app-amber-4",
  purple: "bg-app-purple-1 text-app-purple-4",
  green: "bg-app-green-1 text-app-green-4",
  pink: "bg-app-pink-1 text-app-pink-4",
  orange: "bg-app-orange-1 text-app-orange-4",
};

const THREAD_INDEX = new Map<string, ThreadEntry>(
  Object.values(THREADS).flatMap((group) => group.map((t) => [t.id, t] as const)),
);

export function findThread(id: string): ThreadEntry | undefined {
  return THREAD_INDEX.get(id);
}
