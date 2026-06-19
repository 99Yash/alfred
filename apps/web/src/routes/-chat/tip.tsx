import * as Tooltip from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";
import { Kbd } from "~/components/ui/kbd";
import { useAppTheme } from "~/components/ui/v2";
import { cn } from "~/lib/utils";

/**
 * Styled hover hint for chat chrome buttons (composer + top bar). Mirrors the
 * sidebar's `RailTip` grammar — a dark pill with the action label — and, when a
 * shortcut exists, trails a `Kbd` chip so the binding is discoverable without
 * docs. Borrowed from dimension, whose icon buttons all carry shortcut tooltips.
 *
 * Wrap the surface once in a `Tooltip.Provider`; each `Tip` is a self-contained
 * Root/Trigger/Content.
 */
export function Tip({
  label,
  keys,
  side = "top",
  children,
}: {
  label: string;
  /** Optional shortcut glyphs (e.g. `["↵"]`), rendered as trailing Kbd chips. */
  keys?: readonly string[];
  side?: Tooltip.TooltipContentProps["side"];
  children: ReactNode;
}) {
  const { resolved } = useAppTheme();
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side={side}
          sideOffset={8}
          data-app-theme={resolved}
          className={cn(
            "app z-[200] inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium",
            "bg-app-fg-4 text-app-bg-1 shadow-[0_2px_8px_rgba(0,0,0,0.18)]",
            "select-none data-[state=delayed-open]:animate-[app-fade-in_120ms_ease-out]",
          )}
        >
          <span>{label}</span>
          {keys?.map((k) => (
            <Kbd key={k} className="border-app-bg-1/20 bg-app-bg-1/10 text-app-bg-1/80">
              {k}
            </Kbd>
          ))}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
