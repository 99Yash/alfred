import type { ArtifactFormat, ArtifactPage } from "@alfred/contracts";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useCallback, useEffect, type Dispatch, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { ArtifactPageFrame } from "~/components/artifact-page-frame";
import { cn } from "~/lib/utils";
import { ArtifactIconButton } from "./artifact-icon-button";
import { useArtifactPageKeys } from "./use-artifact-pages";

/**
 * Fullscreen presentation for a `pages` artifact — one page at a time over a
 * near-black backdrop, with arrow-key and button navigation.
 *
 * The overlay portals to `document.body` because both hosts sit inside a
 * transformed box (the chat panel's entrance animation, the library's dialog),
 * and a transformed ancestor makes `fixed inset-0` resolve against that box
 * instead of the viewport.
 */
export function ArtifactPresentOverlay({
  title,
  pages,
  format,
  index,
  onIndexChange,
  onClose,
}: {
  title: string;
  pages: ArtifactPage[];
  format: ArtifactFormat;
  /** Current page, shared with the host so entry and exit keep position. */
  index: number;
  onIndexChange: Dispatch<SetStateAction<number>>;
  onClose: () => void;
}) {
  const safeIndex = pages.length === 0 ? 0 : Math.min(index, pages.length - 1);

  useArtifactPageKeys({ enabled: true, pageCount: pages.length, onIndexChange });

  const go = useCallback(
    (delta: number) =>
      onIndexChange((i) => {
        const next = i + delta;

        if (next < 0) return 0;

        if (next > pages.length - 1) return Math.max(0, pages.length - 1);

        return next;
      }),
    [pages.length, onIndexChange],
  );

  // Lock background scroll while presenting.
  useEffect(() => {
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  const current = pages[safeIndex];

  return createPortal(
    <div className="animate-artifact-fullscreen fixed inset-0 z-[80] flex flex-col bg-black/90 backdrop-blur-sm">
      <div className="flex h-12 shrink-0 items-center justify-between px-4 text-white/80">
        <span className="truncate text-sm">{title}</span>
        <div className="flex items-center gap-3">
          <span className="text-[12px] tabular-nums">
            {safeIndex + 1} / {pages.length}
          </span>
          <ArtifactIconButton label="Exit fullscreen" onClick={onClose} tone="dark">
            <X size={16} />
          </ArtifactIconButton>
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-12 pb-8">
        <NavButton side="left" disabled={safeIndex === 0} onClick={() => go(-1)} />
        <div
          className={cn(
            "animate-artifact-fullscreen-content w-full",
            format === "slides" ? "max-w-[1100px]" : "max-w-[760px]",
          )}
        >
          {current ? (
            <ArtifactPageFrame
              html={current.html}
              title={current.title || `Page ${safeIndex + 1}`}
              format={format}
              className="shadow-2xl"
            />
          ) : null}
        </div>
        <NavButton side="right" disabled={safeIndex >= pages.length - 1} onClick={() => go(1)} />
      </div>
    </div>,
    document.body,
  );
}

function NavButton({
  side,
  disabled,
  onClick,
}: {
  side: "left" | "right";
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={side === "left" ? "Previous page" : "Next page"}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "absolute top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-full",
        "bg-white/10 text-white transition-colors hover:bg-white/20",
        "disabled:cursor-not-allowed disabled:opacity-30",
        side === "left" ? "left-3" : "right-3",
      )}
    >
      {side === "left" ? <ChevronLeft size={20} /> : <ChevronRight size={20} />}
    </button>
  );
}
