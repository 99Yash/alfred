import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/* The `--radius-*` role tiers in index.css `@theme`. tailwind-merge only knows
 * t-shirt radius names, so without this `cn("rounded-control", "rounded-full")`
 * keeps both classes and stylesheet order picks the winner. */
const twMerge = extendTailwindMerge({
  extend: { theme: { radius: ["control-xs", "control-sm", "control", "surface", "panel"] } },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
