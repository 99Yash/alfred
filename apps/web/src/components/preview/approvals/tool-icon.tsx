import { CalendarPlus, Mail, type LucideIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import type { ToolName } from "./types";

export function ToolIcon({ toolName }: { toolName: ToolName }) {
  const Icon: LucideIcon = toolName === "gmail.send_draft" ? Mail : CalendarPlus;
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-10 shrink-0 place-items-center rounded-xl",
        toolName === "gmail.send_draft"
          ? "bg-vs-red-1 text-vs-red-4"
          : "bg-vs-blue-1 text-vs-blue-4",
      )}
    >
      <Icon size={18} />
    </span>
  );
}
