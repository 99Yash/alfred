import type { ReactNode } from "react";
import { AppCard } from "~/components/ui/v2";
import { IntegrationIcon, type IntegrationBrand } from "~/lib/integrations/integration-icons";

/**
 * Brand artwork goes in bare; a lucide glyph gets a frame. The caller names
 * the kind, so an unframed glyph cannot be expressed.
 */
export type McpTileIcon =
  | { readonly brand: IntegrationBrand; readonly connected: boolean }
  | { readonly glyph: ReactNode };

/** One MCP grid tile. Not `ConnectionCard`: the last tile is "add a server". */
export function McpTile({
  icon,
  label,
  subtitle,
  warning = false,
  children,
}: {
  icon: McpTileIcon;
  label: string;
  subtitle: ReactNode;
  warning?: boolean;
  children: ReactNode;
}) {
  return (
    <AppCard padded={false} className="flex items-center gap-3 px-3 py-2.5">
      {/* The icon keeps its identity; a fault adds a badge where "Connected" puts its check. */}
      <span className="relative shrink-0">
        {"brand" in icon ? (
          <IntegrationIcon
            brand={icon.brand}
            connected={icon.connected}
            className="size-9 rounded-full"
          />
        ) : (
          <span
            className="grid size-9 place-items-center rounded-control bg-app-bg-2 text-app-fg-3 ring-1 ring-app-bg-3"
            aria-hidden
          >
            {icon.glyph}
          </span>
        )}
        {warning ? (
          <span
            aria-hidden
            className="absolute -right-0.5 -bottom-0.5 z-10 grid size-4 place-items-center rounded-full bg-app-amber-4 text-[10px] leading-none font-bold text-app-bg-1 shadow-[0_1px_4px_rgba(0,0,0,0.28)] ring-2 ring-app-background"
          >
            !
          </span>
        ) : null}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-app-fg-4">{label}</p>
        <div className={`text-xs ${warning ? "text-app-amber-4" : "truncate text-app-fg-3"}`}>
          {subtitle}
        </div>
      </div>
      {children}
    </AppCard>
  );
}
