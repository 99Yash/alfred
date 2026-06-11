/**
 * `<AppThemed>` — combines the `.app` opt-in class with the correct
 * `data-app-theme` attribute so callers don't have to wire it themselves.
 *
 * We always stamp the *resolved* theme (`"dark"` | `"light"`), even in
 * "system" mode, rather than leaving the attribute off and deferring to the
 * `@media (prefers-color-scheme)` block. Deferring to @media means the dark
 * tokens only land on `.app` once index.css is applied; in the Vite dev server
 * that lands a beat late on a cold mobile load, so `.app` momentarily falls
 * through to the LIGHT `:root` baseline. With `color-scheme: dark` already
 * forcing a dark UA canvas (see index.html), the result is a dark page whose
 * focus rings paint their `ring-offset` in the light `--app-background`
 * (`#ffffff`) — a bright white band around the auto-focused chat composer until
 * refresh. Stamping the resolved attribute makes `.app` carry the dark token
 * block deterministically, with no @media timing dependency. The provider's
 * matchMedia listener keeps `resolved` in sync when the OS theme changes, so
 * "system" still auto-follows — it just does so through React, not raw CSS.
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
  // No provider mounted → fall back to `.app` with no attribute, which lets the
  // @media block track system preference (the original behavior). With a
  // provider, always write the resolved theme so the tokens are deterministic.
  const dataTheme = ctx?.resolved;
  const Comp = As as React.ElementType;
  return (
    <Comp className={cn("app", className)} data-app-theme={dataTheme} {...rest}>
      {children}
    </Comp>
  );
}
