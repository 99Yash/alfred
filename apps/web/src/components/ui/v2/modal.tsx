/**
 * App-grammar Modal primitive.
 *
 * One component, two shells: a centered dialog at `sm` and up, a bottom sheet
 * below it. The mobile shell is a `vaul` drawer, so it drags to dismiss. Both
 * branches are controlled by the same `open` / `onOpenChange` pair.
 *
 * The body is the caller's: give the content its own padding (`px-6 pb-6` to
 * match the dialog's header inset). The dialog branch renders alfred's themed
 * `DialogContent`, which paints its own title and description; the sheet branch
 * renders the same two slots as a `vaul` title and description.
 */

import { Drawer } from "vaul";
import { use, useSyncExternalStore, type ReactNode } from "react";
import { Dialog, DialogContent } from "~/components/ui/dialog";
import { cn } from "~/lib/utils";
import { AppThemeContext } from "./theme";

const DESKTOP_QUERY = "(min-width: 640px)";

function subscribeToDesktop(onChange: () => void): () => void {
  const media = window.matchMedia(DESKTOP_QUERY);
  media.addEventListener("change", onChange);

  return () => media.removeEventListener("change", onChange);
}

function getIsDesktop(): boolean {
  return window.matchMedia(DESKTOP_QUERY).matches;
}

/** Desktop is the safe default when there is no `window` to measure. */
function getIsDesktopServer(): boolean {
  return true;
}

function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribeToDesktop, getIsDesktop, getIsDesktopServer);
}

interface AppModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode | undefined;
  /** Extra classes on the panel. Applies to both the dialog and the sheet. */
  className?: string | undefined;
  children: ReactNode;
}

export function AppModal({
  open,
  onOpenChange,
  title,
  description,
  className,
  children,
}: AppModalProps) {
  const isDesktop = useIsDesktop();
  // The sheet portals outside the `.app` subtree, so CSS token inheritance
  // breaks. Stamp the resolved theme directly, as AppSelect and DialogContent
  // do; React context still flows through the portal.
  const themeCtx = use(AppThemeContext);
  const dataTheme = themeCtx?.resolved;

  if (isDesktop) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent title={title} description={description} themed className={className}>
          {children}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-[2px]" />
        <Drawer.Content
          data-app-theme={dataTheme}
          className={cn(
            "app fixed inset-x-0 bottom-0 z-[101] flex max-h-[90vh] flex-col",
            "rounded-t-3xl bg-app-bg-1 text-app-fg-4 outline-none",
            className,
          )}
        >
          <div className="mx-auto mt-3 h-1.5 w-12 shrink-0 rounded-full bg-app-bg-3" aria-hidden />
          <Drawer.Title className="px-6 pt-3 text-base font-medium text-app-fg-4">
            {title}
          </Drawer.Title>
          {description ? (
            <Drawer.Description className="px-6 pt-1 text-[13px] text-app-fg-3">
              {description}
            </Drawer.Description>
          ) : (
            <Drawer.Description className="sr-only">Sheet content follows.</Drawer.Description>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
