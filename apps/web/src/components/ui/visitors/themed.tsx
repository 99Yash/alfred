/**
 * `<VsThemed>` — combines the `.vs` opt-in class with the correct
 * `data-vs-theme` attribute so callers don't have to wire it themselves.
 *
 * When `mode === "system"` no attribute is written, letting the
 * @media block in index.css resolve it from prefers-color-scheme.
 */

import { useContext, type HTMLAttributes } from "react";
import { cn } from "~/lib/utils";
import { VsThemeContext } from "./theme";

export function VsThemed({
  as: As = "div",
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { as?: "div" | "main" | "section" | "article" }) {
  const ctx = useContext(VsThemeContext);
  // If no provider is mounted, fall back to .vs with no attribute — which
  // means "track system preference" via the @media block.
  const dataTheme = ctx?.mode === "dark" || ctx?.mode === "light" ? ctx.mode : undefined;
  const Comp = As as React.ElementType;
  return (
    <Comp className={cn("vs", className)} data-vs-theme={dataTheme} {...rest}>
      {children}
    </Comp>
  );
}
