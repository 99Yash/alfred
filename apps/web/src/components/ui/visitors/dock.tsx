/**
 * Visitors-now-grammar floating bottom dock.
 *
 * Fixed at the bottom-center of the viewport. A `bg-vs-fg-4` (brand ink)
 * rounded-full pill containing icon-only buttons. The active item gets a
 * `bg-vs-purple-a3` violet pad behind it; counts (live visitor count)
 * render as a tiny label to the right of the active item's icon.
 *
 * The dock is the secondary navigation surface on visitors.now — it lives
 * everywhere, not per-page. Use it for routes that share a common
 * sub-nav (e.g., Realtime / Performance / Settings within a project).
 */

import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

export interface VsDockItem {
  id: string;
  icon: ReactNode;
  label: string;
  /** Render as link or button — provide href to make it a link. */
  href?: string;
  onClick?: () => void;
  /** When truthy and the item is active, renders as a small count chip next to the icon. */
  badge?: string | number;
}

interface VsDockProps {
  items: VsDockItem[];
  activeId: string;
  className?: string;
}

export function VsDock({ items, activeId, className }: VsDockProps) {
  return (
    <div
      className={cn(
        "fixed bottom-3 left-1/2 -translate-x-1/2 z-50",
        "flex items-center gap-1 p-1",
        "rounded-full bg-vs-fg-4 text-white",
        "shadow-[0_8px_24px_rgba(0,0,0,0.18),0_2px_6px_rgba(0,0,0,0.12)]",
        className,
      )}
      role="navigation"
      aria-label="Project navigation"
    >
      {items.map((it) => {
        const isActive = it.id === activeId;
        const inner = (
          <span
            className={cn(
              "relative inline-flex items-center justify-center h-8 rounded-full transition-colors",
              "text-white/70 hover:text-white",
              isActive
                ? "bg-vs-purple-4/30 text-white px-2.5 gap-1.5"
                : "size-8 hover:bg-white/5",
            )}
          >
            <span className="size-4 inline-flex items-center justify-center">{it.icon}</span>
            {isActive && it.badge !== undefined ? (
              <span className="text-[11px] font-medium tabular-nums leading-none">{it.badge}</span>
            ) : null}
          </span>
        );

        if (it.href) {
          return (
            <a key={it.id} href={it.href} aria-label={it.label} aria-current={isActive ? "page" : undefined} className="vs-press outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-3 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-fg-4 rounded-full">
              {inner}
            </a>
          );
        }
        return (
          <button key={it.id} type="button" onClick={it.onClick} aria-label={it.label} aria-current={isActive ? "page" : undefined} className="vs-press outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-3 focus-visible:ring-offset-2 focus-visible:ring-offset-vs-fg-4 rounded-full">
            {inner}
          </button>
        );
      })}
    </div>
  );
}
