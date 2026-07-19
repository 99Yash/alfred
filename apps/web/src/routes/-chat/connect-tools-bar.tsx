import { ArrowRight, Check } from "lucide-react";
import { useMemo, useState } from "react";
import { AllIntegrationsDialog } from "~/routes/-integrations/all-integrations-dialog";
import { IntegrationGlyph } from "~/lib/integrations/integration-icons";
import { PROVIDER_BACKEND } from "~/lib/integrations/integrations";
import { useResolvedIntegrations } from "~/lib/integrations/use-integration-status";
import { cn } from "~/lib/utils";
import { Tip } from "./tip";

export function ConnectToolsBar() {
  // Opens the full-catalog dialog in place instead of routing to
  // /integrations, mirroring dimension's "Connect Your Tools" affordance.
  const [dialogOpen, setDialogOpen] = useState(false);
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
    <>
      <button
        type="button"
        onClick={() => setDialogOpen(true)}
        aria-label="Connect your tools"
        aria-haspopup="dialog"
        className={cn(
          // A frosted shelf docked just under the composer: inset from the
          // input's edges and hung a hair below it so the two read as one
          // stacked affordance — label on the left, tool marks on the right,
          // hover-reveal arrow trailing. Mirrors dimension's
          // `ConnectIntegrationsBar`, re-tokenized onto Alfred's frost material.
          "group relative mx-auto mt-2 flex w-[calc(100%-2rem)] items-center gap-3",
          "rounded-2xl px-4 py-3",
          // Shared frosted material: hairline gradient rim + inset sheen (the
          // same `.frost-border` the composer's surface uses) over a translucent
          // fill, with a soft drop shadow so the shelf reads as lifted glass.
          "frost-border bg-app-bg-2/50 backdrop-blur-sm",
          "shadow-[0_4px_12px_-2px_rgba(0,0,0,0.18)]",
          "transition-colors duration-200 hover:bg-app-bg-2/70",
          "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2",
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

        <div className="ml-auto flex items-center">
          {/* Overlapping stack: each glyph sits on its own tile ringed in the
           * page background, so a slight negative margin reads as a clean
           * "cut-out" overlap rather than a collision. Connected tiles lift
           * above their neighbours (z-10) so their check badge stays visible;
           * the hovered tile floats above everything (z-20). */}
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

          {/* Hover-reveal arrow — collapses to zero width until the shelf is
           * hovered/focused, then slides open. CSS-only (no motion runtime);
           * `motion-reduce` snaps it open so reduced-motion users still see it. */}
          <span
            aria-hidden
            className={cn(
              "flex w-0 items-center justify-center overflow-hidden text-app-fg-3 opacity-0",
              "transition-all duration-200 ease-out",
              "group-hover:w-5 group-hover:pl-2 group-hover:opacity-100",
              "group-focus-visible:w-5 group-focus-visible:pl-2 group-focus-visible:opacity-100",
              "motion-reduce:transition-none",
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
