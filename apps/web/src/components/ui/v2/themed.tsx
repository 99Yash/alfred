/**
 * `<AppThemed>` — combines the `.app` opt-in class with the correct
 * `data-app-theme` attribute so callers don't have to wire it themselves.
 *
 * When `mode === "system"` no attribute is written, letting the
 * @media block in index.css resolve it from prefers-color-scheme.
 */

import { use, type HTMLAttributes } from "react";
import { cn } from "~/lib/utils";
import { AppThemeContext } from "./theme";

export function AppThemed({
  as: As = "div",
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { as?: "div" | "main" | "section" | "article" }) {
  const ctx = use(AppThemeContext);
  // If no provider is mounted, fall back to .app with no attribute — which
  // means "track system preference" via the @media block.
  const dataTheme = ctx?.mode === "dark" || ctx?.mode === "light" ? ctx.mode : undefined;
  const Comp = As as React.ElementType;
  return (
    <Comp className={cn("app", className)} data-app-theme={dataTheme} {...rest}>
      {children}
    </Comp>
  );
}
