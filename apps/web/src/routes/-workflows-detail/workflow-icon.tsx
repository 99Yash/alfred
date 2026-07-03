import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

export function WorkflowIcon({
  children,
  tone,
}: {
  children: ReactNode;
  tone: "green" | "purple";
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-9 shrink-0 place-items-center rounded-xl",
        tone === "green" ? "bg-app-green-1 text-app-green-4" : "bg-app-purple-1 text-app-purple-4",
      )}
    >
      {children}
    </span>
  );
}
