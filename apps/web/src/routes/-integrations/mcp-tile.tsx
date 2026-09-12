import type { ReactNode } from "react";
import { AppCard } from "~/components/ui/v2";
import { IntegrationIcon, type IntegrationBrand } from "~/lib/integrations/integration-icons";

/**
 * The leading mark on a tile, as a CLOSED choice of the two kinds that exist.
 *
 * Brand artwork carries its own background and shape, so it goes in bare. A
 * lucide glyph does not, and an unframed one reads as a stray mark beside a
 * brand coin. A tile cannot tell the two apart by looking at a `ReactNode`, so
 * the caller NAMES which kind it holds and the tile owns both boxes. That keeps
 * the one 9x9 measurement in one place and makes an unframed glyph
 * unrepresentable rather than merely discouraged.
 */
export type McpTileIcon =
  | { readonly brand: IntegrationBrand; readonly connected: boolean }
  | { readonly glyph: ReactNode };

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
  icon: McpTileIcon;
  label: string;
  subtitle: ReactNode;
  children: ReactNode;
}) {
  return (
    <AppCard padded={false} className="flex items-center gap-3 px-3 py-2.5">
      {"brand" in icon ? (
        <IntegrationIcon
          brand={icon.brand}
          connected={icon.connected}
          className="size-9 shrink-0 rounded-full"
        />
      ) : (
        <span
          className="grid size-9 shrink-0 place-items-center rounded-xl bg-app-bg-2 text-app-fg-3 ring-1 ring-app-bg-3"
          aria-hidden
        >
          {icon.glyph}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-app-fg-4">{label}</p>
        <p className="truncate text-xs text-app-fg-3">{subtitle}</p>
      </div>
      {children}
    </AppCard>
  );
}
