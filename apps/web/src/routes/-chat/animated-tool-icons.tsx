import { Cctv, Check, Fan, Globe, ScanText, SquarePen, type LucideIcon } from "lucide-react";
import { cn } from "~/lib/utils";

interface AnimatedToolIconDefinition {
  key: string;
  Icon: LucideIcon;
}

// Keyed by full tool name. Tools absent here fall back to their static Lucide
// glyph. spawn/load tools only reach this map when no target brand resolved -
// otherwise the card shows the target integration's logo instead.
const ANIMATED_TOOL_ICONS: Record<string, AnimatedToolIconDefinition> = {
  "system.web_search": { key: "globe", Icon: Globe },
  "system.fetch_url": { key: "globe", Icon: Globe },
  "system.spawn_sub_agent": { key: "fan", Icon: Fan },
  "system.await_sub_agent": { key: "cctv", Icon: Cctv },
  "system.remember": { key: "scan-text", Icon: ScanText },
  "system.read_user_context": { key: "scan-text", Icon: ScanText },
  "system.suggest_todo": { key: "square-pen", Icon: SquarePen },
  "system.resolve_todo": { key: "check", Icon: Check },
};

/** The animated icon for a tool, or `undefined` to keep the static fallback. */
export function animatedToolIcon(toolName: string): AnimatedToolIconDefinition | undefined {
  return ANIMATED_TOOL_ICONS[toolName];
}

/**
 * Renders a tool glyph that pulses while `running` is true. The actual motion is
 * CSS so the app's `prefers-reduced-motion` block can disable it globally.
 */
export function RunningToolIcon({
  icon: Icon,
  running,
  size = 13,
}: {
  icon: LucideIcon;
  running: boolean;
  size?: number;
}) {
  return (
    <Icon
      size={size}
      className={cn("tool-animated-icon", running && "tool-animated-icon--running")}
    />
  );
}
