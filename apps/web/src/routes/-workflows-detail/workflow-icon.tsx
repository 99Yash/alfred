import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

export type WorkflowIconTone = "green" | "purple" | "amber" | "red" | "muted";

const TONE = {
  green: "bg-app-green-1 text-app-green-4",
  purple: "bg-app-purple-1 text-app-purple-4",
  amber: "bg-app-amber-1 text-app-amber-4",
  red: "bg-app-red-1 text-app-red-4",
  muted: "bg-app-bg-2 text-app-fg-3",
} satisfies Record<WorkflowIconTone, string>;

export function WorkflowIcon({ children, tone }: { children: ReactNode; tone: WorkflowIconTone }) {
  return (
    <span
      aria-hidden
      className={cn("grid size-9 shrink-0 place-items-center rounded-xl", TONE[tone])}
    >
      {children}
    </span>
  );
}
