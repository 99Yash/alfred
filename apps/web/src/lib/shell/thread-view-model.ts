export type ThreadGroup = "pinned" | "today" | "yesterday" | "earlier";

export interface ThreadEntry {
  id: string;
  title: string;
  pinned?: boolean | undefined;
  unread?: boolean | undefined;
}

export interface RecentThread {
  id: string;
  title: string;
  when: string;
}

export interface ShellThreadViewModel {
  groups: Record<ThreadGroup, ThreadEntry[]>;
  recent: ReadonlyArray<RecentThread>;
  approvalsBadge?: string | undefined;
}
