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
    <AppCard
      padded={false}
      className={`flex items-center gap-3 px-3 py-2.5 ${warning ? "ring-1 ring-app-amber-2" : ""}`}
    >
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
        <div className={`text-xs ${warning ? "text-app-amber-4" : "truncate text-app-fg-3"}`}>
          {subtitle}
        </div>
      </div>
      {children}
    </AppCard>
  );
}
