import * as Tooltip from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";
import { Kbd } from "~/components/ui/kbd";
import { useAppTheme } from "~/components/ui/v2";
import { cn } from "~/lib/utils";

/**
 * Curved-tip pointer (dimension's tooltip arrow). Inherits the pill fill via
 * `fill-app-fg-4` so it reads as one piece with the content, and Radix rotates
 * the wrapper per side automatically. The arrow narrows on the horizontal
 * sides to keep the proportions right when it points left/right.
 */
function TipArrow() {
  return (
    <Tooltip.Arrow asChild>
      <svg
        width="17"
        height="9"
        viewBox="0 0 17 9"
        className={cn(
          "w-3.5 -translate-y-px fill-app-fg-4",
          "group-data-[side=left]/tip:w-3 group-data-[side=right]/tip:w-3",
        )}
      >
        <path d="M16.9853 0.485289L9.20711 8.26347C8.81658 8.654 8.18342 8.654 7.79289 8.26347L0.0147266 0.485289H16.9853Z" />
      </svg>
    </Tooltip.Arrow>
  );
}

/**
 * Styled hover hint for chat chrome buttons (composer + top bar). Mirrors the
 * sidebar's `RailTip` grammar — a dark pill with the action label — and, when a
 * shortcut exists, trails a `Kbd` chip so the binding is discoverable without
 * docs. Borrowed from dimension's elaborate tooltip, whose icon buttons all
 * carry shortcut tooltips and whose richer surfaces add a `description` line.
 *
 * Wrap the surface once in a `Tooltip.Provider`; each `Tip` is a self-contained
 * Root/Trigger/Content. A curved pointer arrow (dimension's rounded-tip shape)
 * ties the pill to its trigger; it inherits the pill fill so it reads as one
 * piece. The pill fades + scales in on open. This is the single tooltip
 * primitive for chat chrome — route every button through it rather than adding
 * a parallel tooltip.
 */
export function Tip({
  label,
  description,
  keys,
  side = "top",
  align = "center",
  sideOffset = 8,
  delayDuration,
  children,
}: {
  /** Primary line. Plain text or rich content. */
  label: ReactNode;
  /** Optional secondary line — fuller explanation under the label. */
  description?: ReactNode;
  /** Optional shortcut glyphs (e.g. `["↵"]`), rendered as trailing Kbd chips. */
  keys?: readonly string[];
  side?: Tooltip.TooltipContentProps["side"];
  align?: Tooltip.TooltipContentProps["align"];
  sideOffset?: number;
  /** Per-tip override of the provider's hover delay. */
  delayDuration?: number;
  children: ReactNode;
}) {
  const { resolved } = useAppTheme();
  return (
    <Tooltip.Root delayDuration={delayDuration}>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={8}
          data-app-theme={resolved}
          className={cn(
            "group/tip app z-200 max-w-[16rem] rounded-lg px-2.5 py-1.5 text-xs",
            "bg-app-fg-4 text-app-bg-1 shadow-[0_2px_8px_rgba(0,0,0,0.18)]",
            "will-change-[transform,opacity] select-none",
            "data-[state=delayed-open]:animate-[app-tooltip-in_140ms_cubic-bezier(0.22,1,0.36,1)]",
          )}
        >
          <div className="flex items-center gap-1.5">
            <span className="font-medium">{label}</span>
            {keys?.map((k) => (
              <Kbd key={k} className="border-app-bg-1/20 bg-app-bg-1/10 text-app-bg-1/80">
                {k}
              </Kbd>
            ))}
          </div>
          {description ? (
            <p className="mt-0.5 leading-snug text-app-bg-1/65">{description}</p>
          ) : null}
          <TipArrow />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
