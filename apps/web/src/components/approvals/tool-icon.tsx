import type { IntegrationSlug } from "@alfred/contracts";
import {
  Calendar,
  FileText,
  Github,
  HardDrive,
  Mail,
  MessageSquare,
  Settings2,
  SquareKanban,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { cn } from "~/lib/utils";

const ICONS: Record<IntegrationSlug, LucideIcon> = {
  system: Settings2,
  gmail: Mail,
  calendar: Calendar,
  drive: HardDrive,
  docs: FileText,
  slack: MessageSquare,
  linear: SquareKanban,
  github: Github,
  imessage: MessageSquare,
};

// Tint by integration so the queue is scannable at a glance. Anything not
// listed falls back to the neutral surface.
const TINTS: Partial<Record<IntegrationSlug, string>> = {
  gmail: "bg-vs-red-1 text-vs-red-4",
  calendar: "bg-vs-blue-1 text-vs-blue-4",
  docs: "bg-vs-sky-1 text-vs-sky-4",
  slack: "bg-vs-purple-1 text-vs-purple-4",
};

export function ToolIcon({ integration }: { integration: IntegrationSlug }) {
  const Icon = ICONS[integration] ?? Wrench;
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-10 shrink-0 place-items-center rounded-xl",
        TINTS[integration] ?? "bg-vs-bg-2 text-vs-fg-3",
      )}
    >
      <Icon size={18} />
    </span>
  );
}
