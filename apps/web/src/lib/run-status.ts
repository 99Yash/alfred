import type { RunStatus } from "@alfred/contracts";

/** One label and tone per run status, shared by every live-status surface. */
export const RUN_STATUS_DISPLAY = {
  pending: { label: "Queued", tone: "muted" },
  runnable: { label: "Queued", tone: "muted" },
  running: { label: "Running", tone: "purple" },
  waiting: { label: "Waiting", tone: "amber" },
  deferred: { label: "Deferred", tone: "amber" },
  blocked: { label: "Blocked", tone: "amber" },
  completed: { label: "Completed", tone: "green" },
  failed: { label: "Failed", tone: "red" },
  cancelled: { label: "Cancelled", tone: "muted" },
} as const satisfies Record<
  RunStatus,
  { label: string; tone: "green" | "purple" | "amber" | "red" | "muted" }
>;
