/**
 * Dimension-grammar Switch primitive.
 *
 * 44×24 track with a 20px thumb. Off → gray-100 fill. On → purple-400 fill,
 * brightening to purple-300 on hover. Frost-border hairline on the track so
 * the switch reads as a "lifted" surface even at rest.
 *
 * Controlled (`checked` + `onCheckedChange`) or uncontrolled (`defaultChecked`).
 * Built on `@radix-ui/react-switch` so we get form association, ARIA wiring,
 * IME-safe keyboard handling, and `data-state` for styling for free.
 */

import * as SwitchPrimitive from "@radix-ui/react-switch";
import type { ComponentPropsWithRef } from "react";
import { cn } from "~/lib/utils";

type SwitchProps = ComponentPropsWithRef<typeof SwitchPrimitive.Root>;

export function Switch({ className, ref, ...rest }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      ref={ref}
      className={cn(
        /* track */
        "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full",
        "frost-border border border-transparent backdrop-blur-sm",
        "transition-[background-color] duration-200",
        /* off / on fills via data-state */
        "data-[state=unchecked]:bg-gray-100 data-[state=unchecked]:hover:bg-gray-200",
        "data-[state=checked]:bg-purple-400 data-[state=checked]:hover:bg-purple-300",
        /* focus */
        "outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-0",
        /* disabled */
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...rest}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none block size-5 rounded-full bg-white",
          "shadow-[0_1px_2px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.4)]",
          "transition-transform duration-200 ease-[cubic-bezier(0.2,0,0,1)]",
          "data-[state=checked]:translate-x-[22px] data-[state=unchecked]:translate-x-0.5",
        )}
      />
    </SwitchPrimitive.Root>
  );
}
