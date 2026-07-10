import type { ShellThreadViewModel } from "~/lib/shell/thread-view-model";

export const PREVIEW_SHELL_THREADS: ShellThreadViewModel = {
  groups: {
    pinned: [{ id: "morning-brief", title: "Morning briefing — Friday", pinned: true }],
    today: [
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
  },
  recent: [
    { id: "morning-brief", title: "Morning briefing — Friday", when: "Today" },
    { id: "sycamore-recap", title: "Sycamore investor update", when: "Today" },
    { id: "calendar-block", title: "Block focus time tomorrow", when: "Today" },
    { id: "triage-rules", title: "Tune triage label rules", when: "Yesterday" },
    { id: "vesting-q", title: "Vesting cliff question", when: "Yesterday" },
    { id: "weekly-recap", title: "Weekly recap — week 21", when: "Earlier" },
    { id: "cold-start", title: "Cold-start research notes", when: "Earlier" },
  ],
  approvalsBadge: "2",
};
