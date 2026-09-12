import type { ReactNode } from "react";
import { AppCard } from "~/components/ui/v2";

/**
 * One tile in the MCP grid: leading icon, label, subtitle, and the caller's
 * actions.
 *
 * Presentation only. It is NOT called `ConnectionCard`, because the grid's last
 * tile is the "add a server" call to action, which is not a connection.
 */
export function McpTile({
  icon,
  label,
  subtitle,
  children,
}: {
  icon: ReactNode;
  label: string;
  subtitle: ReactNode;
  children: ReactNode;
}) {
  return (
    <AppCard padded={false} className="flex items-center gap-3 px-3 py-2.5">
      <span
        className="grid size-9 shrink-0 place-items-center rounded-xl bg-app-bg-2 text-app-fg-3 ring-1 ring-app-bg-3"
        aria-hidden
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-app-fg-4">{label}</p>
        <p className="truncate text-xs text-app-fg-3">{subtitle}</p>
      </div>
      {children}
    </AppCard>
  );
}
