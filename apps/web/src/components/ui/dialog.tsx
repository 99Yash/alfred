/**
 * Dimension-grammar Dialog primitive.
 *
 * Wraps @radix-ui/react-dialog so we get the focus trap, portal, scroll lock,
 * and ARIA wiring for free. Visuals follow the recon recipe §2.9:
 *
 *   overlay: bg-gray-0/70 backdrop-blur(4px), fades in
 *   content: rounded-3xl frost-popover material, fades + zooms 96→100
 *
 * Two slots:
 *   - <Dialog open onOpenChange>  controlled root
 *   - <DialogContent>             panel painted with frost-popover + animation
 *
 * Title/Description are required by Radix for a11y. Pass `srOnlyTitle` to
 * visually hide them when the dialog header is a custom design (e.g. the
 * CommandPalette input is the title affordance).
 */

import * as RadixDialog from "@radix-ui/react-dialog";
import { forwardRef, type ReactNode } from "react";
import { cn } from "~/lib/utils";

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

interface DialogContentProps
  extends Omit<RadixDialog.DialogContentProps, "title"> {
  title: ReactNode;
  description?: ReactNode;
  /** Hide title + description visually but keep them for screen readers. */
  srOnlyHeader?: boolean;
  /** Override the content shell. Default ships the frost-popover panel. */
  className?: string;
  /** Override the overlay. Default ships the gray-0/70 scrim. */
  overlayClassName?: string;
}

export const DialogContent = forwardRef<HTMLDivElement, DialogContentProps>(
  function DialogContent(
    {
      title,
      description,
      srOnlyHeader = false,
      className,
      overlayClassName,
      children,
      ...rest
    },
    ref,
  ) {
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
          className={cn(
            "fixed left-1/2 top-1/2 z-[101]",
            "-translate-x-1/2 -translate-y-1/2",
            "w-[calc(100vw-2rem)] max-w-lg",
            "rounded-3xl frost-popover",
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
            <div className="px-6 pt-5 pb-3 space-y-1">
              <RadixDialog.Title className="text-base font-medium text-gray-1000">
                {title}
              </RadixDialog.Title>
              {description ? (
                <RadixDialog.Description className="text-[13px] text-gray-800">
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
  },
);
