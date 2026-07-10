import { Link } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { useMemo } from "react";
import { IntegrationGlyph } from "~/lib/integrations/integration-icons";
import { PROVIDER_BACKEND } from "~/lib/integrations/integrations";
import { useResolvedIntegrations } from "~/lib/integrations/use-integration-status";
import { cn } from "~/lib/utils";
import { Tip } from "./tip";

export function ConnectToolsBar() {
  // Drive the row off the real catalog overlaid with live credential state
  // instead of a hardcoded brand list. Catalog-only providers stay on the
  // integrations page, but this nudge only shows providers the user can
  // actually connect here.
  const integrations = useResolvedIntegrations();

  // Unconnected first (these are the actual nudge), connected trailing with
  // a check. Catalog order is preserved within each group.
  const ordered = useMemo(() => {
    const visible = integrations.filter(
      (p) => p.status === "connected" || PROVIDER_BACKEND[p.id] !== undefined,
    );
    const unconnected = visible.filter((p) => p.status !== "connected");
    const connected = visible.filter((p) => p.status === "connected");
    return { unconnected, connected, all: [...unconnected, ...connected] };
  }, [integrations]);

  // Everything actionable in this row is already connected, so drop the nudge.
  if (ordered.unconnected.length === 0) return null;

  return (
    <Link
      to="/integrations"
      aria-label="Connect your tools"
      className={cn(
        // No card, no fill, no divider — just a tappable row floating
        // below the composer. Mirrors dimension's `00-chat-new-initial`
        // reference: label on the left, icons on the right, page bg
        // showing through.
        "group mt-4 flex items-center gap-3 px-1.5",
        "rounded-md outline-none",
        "focus-visible:ring-2 focus-visible:ring-app-purple-2",
        "focus-visible:ring-offset-4 focus-visible:ring-offset-app-background",
      )}
    >
      <span
        className={cn(
          "text-[13px] font-medium text-app-fg-2",
          "transition-colors duration-200 group-hover:text-app-fg-4",
        )}
      >
        Connect your tools
      </span>

      {/* Overlapping stack: each glyph sits on its own tile ringed in the
       * page background, so a slight negative margin reads as a clean
       * "cut-out" overlap rather than a collision. Connected tiles lift
       * above their neighbours (z-10) so their check badge stays visible;
       * the hovered tile floats above everything (z-20). */}
      <div className="ml-auto flex items-center">
        {ordered.all.map((p, i) => {
          const connected = p.status === "connected";
          return (
            <Tip key={p.id} label={connected ? `${p.name} — connected` : p.name}>
              <span
                className={cn(
                  "relative grid size-[22px] shrink-0 place-items-center rounded-full",
                  "bg-app-bg-2 ring-2 ring-app-background",
                  i > 0 && "-ml-1.5",
                  "transition-transform duration-200 ease-out hover:z-20 hover:scale-110",
                  connected ? "z-10" : "",
                )}
              >
                <span className="sr-only">{connected ? `${p.name}, connected` : p.name}</span>
                <IntegrationGlyph
                  brand={p.brand}
                  size={14}
                  className={cn(
                    "transition-opacity duration-200",
                    connected ? "opacity-100" : "opacity-70 group-hover:opacity-100",
                  )}
                />
                {connected ? (
                  <span
                    aria-hidden
                    className={cn(
                      "absolute -right-0.5 -bottom-0.5 grid size-2.5 place-items-center",
                      "rounded-full bg-emerald-400 text-black",
                      "ring-2 ring-app-background",
                    )}
                  >
                    <Check size={7} strokeWidth={3.5} />
                  </span>
                ) : null}
              </span>
            </Tip>
          );
        })}
      </div>
    </Link>
  );
}
