import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

/**
 * The editor box geometry. The Tiptap editor and its load skeleton both use it,
 * so the skeleton has the editor's exact size and the swap does not shift layout.
 */
export const COMPOSER_EDITOR_BOX = cn(
  "tiptap-minimum-input composer-editor",
  "min-h-[64px] px-3 pt-2 pb-1.5",
  "text-[15px] leading-7 font-medium tracking-tight",
);

/** The empty-editor placeholder, on the editor's first line (px-3 pt-2). */
export function ComposerPlaceholder({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute top-2 left-3",
        "text-[15px] leading-7 font-medium tracking-tight text-app-fg-2",
      )}
    >
      {children}
    </span>
  );
}
