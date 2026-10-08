/**
 * `.app` plus the resolved `data-app-theme`, even in "system" mode.
 * Leaving it to the index.css media query flashed light tokens on a cold
 * mobile load in Vite dev. The provider still follows OS changes.
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
  // No provider: no attribute, so the media query tracks the system theme.
  const dataTheme = ctx?.resolved;
  // SAFETY: `As` is a component or tag, which is what React.ElementType means.
  const Comp = As as React.ElementType;

  return (
    <Comp className={cn("app", className)} data-app-theme={dataTheme} {...rest}>
      {children}
    </Comp>
  );
}
