import { ArrowRight, Check } from "lucide-react";
import { useMemo, useState } from "react";
import { AllIntegrationsDialog } from "~/routes/-integrations/all-integrations-dialog";
import { isLiveProviderSlug } from "@alfred/contracts";
import { IntegrationGlyph } from "~/lib/integrations/integration-icons";
import { useResolvedIntegrations } from "~/lib/integrations/use-integration-status";
import { cn } from "~/lib/utils";
import { Tip } from "./tip";

export function ConnectToolsBar() {
  // Opens the catalog dialog in place instead of routing to /integrations.
  const [dialogOpen, setDialogOpen] = useState(false);
  // The real catalog with live credential state. Only providers connectable here.
  const integrations = useResolvedIntegrations();

  // Unconnected first, connected last with a check. Catalog order within each.
  const ordered = useMemo(() => {
    const visible = integrations.filter((p) => isLiveProviderSlug(p.slug));
    const unconnected = visible.filter((p) => p.status !== "connected");
    const connected = visible.filter((p) => p.status === "connected");

    return { unconnected, connected, all: [...unconnected, ...connected] };
  }, [integrations]);

  // Everything is connected: no nudge.
  if (ordered.unconnected.length === 0) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setDialogOpen(true)}
        aria-label="Connect your tools"
        aria-haspopup="dialog"
        className={cn(
          // A quiet centered pill under the composer, secondary to it.
          "group relative mx-auto mt-3 flex w-fit items-center gap-2.5",
          "rounded-full px-3.5 py-2",
          // Transparent at rest; a fill on hover, a press-scale on pointer-down.
          "bg-transparent transition-[background-color,transform] duration-300",
          "ease-[cubic-bezier(0.22,1,0.36,1)]",
          "hover:bg-app-bg-2/60 hover:backdrop-blur-sm",
          "focus-visible:bg-app-bg-2/60 focus-visible:backdrop-blur-sm",
          "active:scale-[0.98] motion-reduce:active:scale-100",
          "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2/60",
          "focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
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

        <div className="flex items-center">
          {/* The glyphs shift right with the arrow, on the same 300ms curve. */}
          <span
            className={cn(
              "flex items-center transition-transform duration-300",
              "ease-[cubic-bezier(0.22,1,0.36,1)]",
              "group-hover:translate-x-1 group-focus-visible:translate-x-1",
              "motion-reduce:translate-x-0 motion-reduce:transition-none",
            )}
          >
            {/* Overlapping tiles. Connected ones sit higher (z-10) so the check shows; hover is z-20. */}
            {ordered.all.map((p, i) => {
              const connected = p.status === "connected";

              return (
                <Tip key={p.slug} label={connected ? `${p.name} — connected` : p.name}>
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
          </span>

          {/* The arrow's slot is always reserved, so the pill never reflows. */}
          <span
            aria-hidden
            className={cn(
              "ml-1.5 flex w-3 items-center justify-center text-app-fg-3",
              "-translate-x-1 opacity-0 transition-[transform,opacity] duration-300",
              "ease-[cubic-bezier(0.22,1,0.36,1)]",
              "group-hover:translate-x-0 group-hover:opacity-100",
              "group-focus-visible:translate-x-0 group-focus-visible:opacity-100",
              "motion-reduce:translate-x-0 motion-reduce:transition-none",
            )}
          >
            <ArrowRight className="size-3 shrink-0" strokeWidth={2.25} />
          </span>
        </div>
      </button>
      <AllIntegrationsDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}
