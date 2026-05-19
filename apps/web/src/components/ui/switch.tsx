/**
 * Dimension-grammar Switch primitive.
 *
 * 44×24 track with a 20px thumb. Off → gray-100 fill. On → purple-400 fill,
 * brightening to purple-300 on hover. Frost-border hairline on the track so
 * the switch reads as a "lifted" surface even at rest.
 *
 * Controlled (`checked` + `onCheckedChange`) or uncontrolled (`defaultChecked`).
 * Hand-rolled — no Radix dependency. Implements ARIA `role="switch"` +
 * `aria-checked` + Space/Enter activation.
 *
 * Recipe pulled from dimension-design-reference-2026-05-18.md §2.5.
 */

import { forwardRef, useCallback, useState, type ButtonHTMLAttributes } from "react";
import { cn } from "~/lib/utils";

interface SwitchProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "onChange" | "type" | "value"
> {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, defaultChecked = false, onCheckedChange, disabled, className, onClick, ...rest },
  ref,
) {
  const isControlled = checked !== undefined;
  const [internal, setInternal] = useState(defaultChecked);
  const value = isControlled ? checked : internal;

  const toggle = useCallback(() => {
    if (disabled) return;
    const next = !value;
    if (!isControlled) setInternal(next);
    onCheckedChange?.(next);
  }, [disabled, value, isControlled, onCheckedChange]);

  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={value}
      data-state={value ? "checked" : "unchecked"}
      disabled={disabled}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented) return;
        toggle();
      }}
      className={cn(
        /* track */
        "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full",
        "frost-border border border-transparent backdrop-blur-sm",
        "transition-[background-color] duration-200",
        /* off / on fills */
        value ? "bg-purple-400 hover:bg-purple-300" : "bg-gray-100 hover:bg-gray-200",
        /* focus */
        "outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-0",
        /* disabled */
        "disabled:opacity-50 disabled:cursor-not-allowed",
        className,
      )}
      {...rest}
    >
      <span
        aria-hidden
        className={cn(
          /* thumb — absolute so we can animate the translate cleanly */
          "pointer-events-none block size-5 rounded-full bg-white",
          "shadow-[0_1px_2px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.4)]",
          "transition-transform duration-200 ease-[cubic-bezier(0.2,0,0,1)]",
          value ? "translate-x-[22px]" : "translate-x-0.5",
        )}
      />
    </button>
  );
});
