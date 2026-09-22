import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

/**
 * The square icon control shared by every artifact surface — the chat sidebar
 * header, the library viewer header, and the presentation bar.
 *
 * `tone="dark"` is for the presentation overlay, which paints its own near-black
 * backdrop instead of an `.app` surface, so the `--app-fg-*` tokens would read
 * as low-contrast there.
 */
export function ArtifactIconButton({
  label,
  children,
  onClick,
  tone = "surface",
}: {
  label: string;
  children: ReactNode;
  onClick?: (() => void) | undefined;
  tone?: "surface" | "dark" | undefined;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-lg transition-colors focus-visible:ring-2 focus-visible:ring-app-fg-3/40 focus-visible:outline-none",
        tone === "dark"
          ? "text-white/70 hover:bg-white/10 hover:text-white"
          : "text-app-fg-3 hover:bg-app-bg-a2 hover:text-app-fg-4",
      )}
    >
      {children}
    </button>
  );
}
