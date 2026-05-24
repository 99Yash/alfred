/**
 * Demo fixture data for the `/preview/*` design routes.
 *
 * The production chrome (AppSidebar, SearchPalette) accepts these via props
 * so the real `/chat`, `/approvals`, … surfaces render empty until Replicache
 * supplies real threads. Only `/preview/*` routes pass these in — that keeps
 * the demo loud and the prod surfaces honest.
 */

export type PreviewThreadGroup = "today" | "yesterday" | "earlier";

export interface PreviewThreadEntry {
  id: string;
  title: string;
  pinned?: boolean;
  unread?: boolean;
}

export const PREVIEW_CHAT_THREADS: Record<PreviewThreadGroup, PreviewThreadEntry[]> = {
  today: [
    { id: "morning-brief", title: "Morning briefing — Friday", pinned: true },
    { id: "sycamore-recap", title: "Sycamore investor update" },
    { id: "calendar-block", title: "Block focus time tomorrow", unread: true },
  ],
  yesterday: [
    { id: "triage-rules", title: "Tune triage label rules" },
    { id: "vesting-q", title: "Vesting cliff question" },
  ],
  earlier: [
    { id: "weekly-recap", title: "Weekly recap — week 21" },
    { id: "cold-start", title: "Cold-start research notes" },
    { id: "memory-cleanup", title: "Memory cleanup pass" },
  ],
};

export interface PreviewRecentThread {
  id: string;
  title: string;
  when: string;
}

export const PREVIEW_RECENT_THREADS: ReadonlyArray<PreviewRecentThread> = [
  { id: "morning-brief", title: "Morning briefing — Friday", when: "Today" },
  { id: "sycamore-recap", title: "Sycamore investor update", when: "Today" },
  { id: "calendar-block", title: "Block focus time tomorrow", when: "Today" },
  { id: "triage-rules", title: "Tune triage label rules", when: "Yesterday" },
  { id: "vesting-q", title: "Vesting cliff question", when: "Yesterday" },
  { id: "weekly-recap", title: "Weekly recap — week 21", when: "Earlier" },
  { id: "cold-start", title: "Cold-start research notes", when: "Earlier" },
];

export const PREVIEW_APPROVALS_BADGE = "2";
