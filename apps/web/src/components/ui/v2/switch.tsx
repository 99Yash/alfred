/**
 * App-grammar Switch primitive.
 *
 * 40×22 track with a 18px thumb. Off → bg-app-bg-3 fill. On → accent gradient
 * (matching the primary AppButton's accent). Thumb is a slightly-elevated
 * white circle in both states.
 *
 * Built on `@radix-ui/react-switch` for the same accessibility wiring as
 * the dimension Switch (form association, ARIA, IME-safe keyboard, etc.).
 */

import * as SwitchPrimitive from "@radix-ui/react-switch";
import type { ComponentPropsWithRef } from "react";
import { cn } from "~/lib/utils";

type AppSwitchProps = ComponentPropsWithRef<typeof SwitchPrimitive.Root>;

export function AppSwitch({ className, ref, ...rest }: AppSwitchProps) {
  return (
    <SwitchPrimitive.Root
      ref={ref}
      className={cn(
        "relative inline-flex h-[22px] w-[40px] shrink-0 cursor-pointer items-center rounded-full",
        "transition-all duration-200",
        /* off / on fills via data-state */
        "data-[state=unchecked]:bg-app-bg-3",
        "data-[state=checked]:bg-[linear-gradient(180deg,var(--app-accent-from)_0%,var(--app-accent-to)_100%)]",
        /* shadow stack — hairline-as-border in both states; on adds an accent glow in light only */
        "data-[state=unchecked]:shadow-[inset_0_0_0_1px_rgba(0,0,0,0.05)]",
        "data-[state=checked]:shadow-[inset_0_1px_0_rgba(255,255,255,0.20),0_1px_2px_rgba(0,0,0,0.15)]",
        /* focus */
        "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-4 focus-visible:ring-offset-app-background",
        /* disabled */
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...rest}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none block size-[18px] rounded-full bg-white",
          "shadow-[0_1px_2px_rgba(0,0,0,0.25)]",
          "transition-transform duration-200 ease-[cubic-bezier(0.2,0,0,1)]",
          "data-[state=checked]:translate-x-[20px] data-[state=unchecked]:translate-x-0.5",
        )}
      />
    </SwitchPrimitive.Root>
  );
}
