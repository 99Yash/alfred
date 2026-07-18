import type {
  ThreadEntry as ShellThreadEntry,
  ThreadGroup as ShellThreadGroup,
} from "~/lib/shell/thread-view-model";
import type { RailInboxItem, RailMeetingItem, RailTodoItem } from "~/routes/-chat/rail/models";

/** Preview fixtures group by time only; "pinned" is a per-entry flag, not a bucket. */
export type ThreadGroup = Exclude<ShellThreadGroup, "pinned">;

/** Canonical thread entry plus the preview blurb the fixtures render. */
export interface PreviewThreadEntry extends ShellThreadEntry {
  preview: string;
}

export const THREADS: Record<ThreadGroup, PreviewThreadEntry[]> = {
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

export const TODOS: RailTodoItem[] = [
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

export const INBOX: RailInboxItem[] = [
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

export const MEETINGS: RailMeetingItem[] = [
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

const THREAD_INDEX = new Map<string, PreviewThreadEntry>(
  Object.values(THREADS).flatMap((group) => group.map((t) => [t.id, t] as const)),
);

export function findThread(id: string): PreviewThreadEntry | undefined {
  return THREAD_INDEX.get(id);
}
