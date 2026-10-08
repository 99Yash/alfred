import * as Tooltip from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";
import { Kbd } from "~/components/ui/kbd";
import { useAppTheme } from "~/components/ui/v2";
import { cn } from "~/lib/utils";

/** Curved tooltip arrow in the pill's fill. Radix rotates it per side. */
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
        <path d="M16.99 0.49L9.21 8.26C8.82 8.65 8.18 8.65 7.79 8.26L0.01 0.49H16.99Z" />
      </svg>
    </Tooltip.Arrow>
  );
}

/**
 * The one tooltip for chat chrome: a dark pill with a label and optional `Kbd` keys.
 * Needs a `Tooltip.Provider` ancestor.
 * Motion is in `.app-tip` (`index.css`): `instant-open` only crossfades, so a sweep does not pop.
 * `disableHoverableContent` drops Radix's grace polygon, which held the old pill open.
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
  /** Plain text or rich content. */
  label: ReactNode;
  /** Second line under the label. */
  description?: ReactNode | undefined;
  /** Shortcut glyphs (e.g. `["↵"]`) as Kbd chips. */
  keys?: readonly string[] | undefined;
  side?: Tooltip.TooltipContentProps["side"] | undefined;
  align?: Tooltip.TooltipContentProps["align"] | undefined;
  sideOffset?: number | undefined;
  delayDuration?: number | undefined;
  children: ReactNode;
}) {
  const { resolved } = useAppTheme();

  return (
    <Tooltip.Root
      disableHoverableContent
      {...(delayDuration === undefined ? {} : { delayDuration })}
    >
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={8}
          data-app-theme={resolved}
          className={cn(
            "app-tip group/tip app z-200 max-w-[16rem] rounded-lg px-2.5 py-1.5 text-xs",
            "bg-app-fg-4 text-app-bg-1 shadow-[0_2px_8px_rgba(0,0,0,0.18)]",
            "select-none",
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
