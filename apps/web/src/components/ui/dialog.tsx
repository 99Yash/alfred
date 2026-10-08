/**
 * Dialog on Radix (focus trap, portal, scroll lock, ARIA) with the frost-popover look.
 * Radix requires a title and description; `srOnlyHeader` hides them visually.
 */

import * as RadixDialog from "@radix-ui/react-dialog";
import { use, type ReactNode, type Ref } from "react";
import { AppThemeContext } from "~/components/ui/v2/theme";
import { cn } from "~/lib/utils";

export const Dialog = RadixDialog.Root;

interface DialogContentProps extends Omit<RadixDialog.DialogContentProps, "title"> {
  title: ReactNode;
  description?: ReactNode | undefined;
  srOnlyHeader?: boolean | undefined;
  /**
   * Use theme-aware app tokens instead of the always-dark `frost-popover`.
   * The portal leaves the `.app` subtree, so this re-stamps `.app` and `data-app-theme`.
   */
  themed?: boolean | undefined;
  className?: string | undefined;
  overlayClassName?: string | undefined;
  ref?: Ref<HTMLDivElement> | undefined;
}

export function DialogContent({
  title,
  description,
  srOnlyHeader = false,
  themed = false,
  className,
  overlayClassName,
  children,
  ref,
  ...rest
}: DialogContentProps) {
  // Context crosses the portal; CSS does not. With no provider, index.css's media query decides.
  const themeCtx = use(AppThemeContext);
  const dataTheme = themed ? themeCtx?.resolved : undefined;

  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay
        className={cn(
          "fixed inset-0 z-[100]",
          "bg-[rgb(var(--gray-0)/0.7)] backdrop-blur-[4px]",
          "data-[state=open]:animate-[dialog-overlay-in_180ms_cubic-bezier(0.2,0,0,1)]",
          "data-[state=closed]:animate-[dialog-overlay-out_140ms_cubic-bezier(0.2,0,0,1)]",
          overlayClassName,
        )}
      />
      <RadixDialog.Content
        ref={ref}
        data-app-theme={dataTheme}
        className={cn(
          "fixed top-1/2 left-1/2 z-[101]",
          "-translate-x-1/2 -translate-y-1/2",
          "w-[calc(100vw-2rem)] max-w-lg",
          themed ? "app app-frost-overlay" : "frost-popover",
          "rounded-3xl",
          "overflow-hidden",
          "data-[state=open]:animate-[dialog-content-in_180ms_cubic-bezier(0.2,0,0,1)]",
          "data-[state=closed]:animate-[dialog-content-out_140ms_cubic-bezier(0.2,0,0,1)]",
          "focus:outline-none",
          className,
        )}
        {...rest}
      >
        {srOnlyHeader ? (
          <>
            <RadixDialog.Title className="sr-only">{title}</RadixDialog.Title>
            <RadixDialog.Description className="sr-only">
              {description ?? "Type to search; use arrow keys to navigate; press Enter to select."}
            </RadixDialog.Description>
          </>
        ) : (
          <div className="space-y-1 px-6 pt-5 pb-3">
            <RadixDialog.Title
              className={cn("text-base font-medium", themed ? "text-app-fg-4" : "text-gray-1000")}
            >
              {title}
            </RadixDialog.Title>
            {description ? (
              <RadixDialog.Description
                className={cn("text-[13px]", themed ? "text-app-fg-3" : "text-gray-800")}
              >
                {description}
              </RadixDialog.Description>
            ) : (
              <RadixDialog.Description className="sr-only">
                Dialog content follows.
              </RadixDialog.Description>
            )}
          </div>
        )}
        {children}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}
