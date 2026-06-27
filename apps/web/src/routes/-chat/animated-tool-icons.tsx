import type { HTMLAttributes, RefAttributes } from "react";
import { useEffect, useRef } from "react";
import { CctvIcon } from "~/components/ui/cctv";
import { CheckIcon } from "~/components/ui/check";
import { ChromeIcon } from "~/components/ui/chrome";
import { FanIcon } from "~/components/ui/fan";
import { LayoutGridIcon } from "~/components/ui/layout-grid";
import { ScanTextIcon } from "~/components/ui/scan-text";
import { SquarePenIcon } from "~/components/ui/square-pen";

/**
 * Animated replacements for the flat Lucide fallbacks shown on system tool
 * rows (lucide-animated.com). The brand-scoped tools keep their real logo
 * coins; this only dresses up the otherwise-identical wrench/sparkle glyphs.
 *
 * Every lucide-animated component shares this handle and a `{ size }` prop,
 * and once a ref is attached it stops auto-animating on hover so we can drive
 * it from the tool's running state instead (see `RunningToolIcon`).
 */
export interface AnimatedIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

export type AnimatedIcon = React.ForwardRefExoticComponent<
  HTMLAttributes<HTMLDivElement> & { size?: number } & RefAttributes<AnimatedIconHandle>
>;

// Keyed by full tool name. Tools absent here fall back to their static Lucide
// glyph. spawn/load tools only reach this map when no target brand resolved —
// otherwise the card shows the target integration's logo instead.
const ANIMATED_TOOL_ICONS: Record<string, AnimatedIcon> = {
  "system.web_search": ChromeIcon,
  "system.fetch_url": ChromeIcon,
  "system.spawn_sub_agent": FanIcon,
  "system.await_sub_agent": CctvIcon,
  "system.load_integration": LayoutGridIcon,
  "system.remember": ScanTextIcon,
  "system.read_user_context": ScanTextIcon,
  "system.suggest_todo": SquarePenIcon,
  "system.resolve_todo": CheckIcon,
};

/** The animated icon for a tool, or `undefined` to keep the static fallback. */
export function animatedToolIcon(toolName: string): AnimatedIcon | undefined {
  return ANIMATED_TOOL_ICONS[toolName];
}

// Each animation is a one-shot draw/spin; re-trigger on a gentle cadence so a
// long-running call keeps a pulse of life rather than freezing after the first
// play. Settles to its resting state the moment the call lands.
const PULSE_MS = 1800;

/**
 * Renders an animated tool glyph that plays while `running` is true. The icon
 * inherits `currentColor` from the surrounding coin, so it reads identically
 * to the static fallback at rest.
 */
export function RunningToolIcon({
  icon: Icon,
  running,
  size = 13,
}: {
  icon: AnimatedIcon;
  running: boolean;
  size?: number;
}) {
  const ref = useRef<AnimatedIconHandle>(null);

  useEffect(() => {
    if (!running) {
      ref.current?.stopAnimation();
      return;
    }
    ref.current?.startAnimation();
    const id = setInterval(() => ref.current?.startAnimation(), PULSE_MS);
    return () => clearInterval(id);
  }, [running]);

  return <Icon ref={ref} size={size} className="inline-flex" />;
}
