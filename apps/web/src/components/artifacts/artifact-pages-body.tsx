import type { ArtifactFormat, ArtifactPage } from "@alfred/contracts";
import { Layers, Loader2 } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import { ArtifactPageFrame } from "~/components/artifact-page-frame";
import { cn } from "~/lib/utils";
import { ArtifactCenteredState } from "./artifact-centered-state";

/**
 * Reader for a `pages` artifact, used by the chat sidebar and the library viewer.
 * The caller owns `pageIndex` so the strip, present button, and overlay agree.
 */
export function ArtifactPagesBody({
  pages,
  format,
  generating,
  pageIndex,
  onPageIndexChange,
  onPresent,
  className,
  pageClassName,
}: {
  pages: ArtifactPage[];
  format: ArtifactFormat;
  generating: boolean;
  pageIndex: number;
  onPageIndexChange: Dispatch<SetStateAction<number>>;
  /** Null removes the zoom control. */
  onPresent: (() => void) | null;
  className?: string | undefined;
  pageClassName?: string | undefined;
}) {
  // Clamp when the list shrinks (an `update_artifact` replace).
  const safeIndex = pages.length === 0 ? 0 : Math.min(pageIndex, pages.length - 1);
  const current = pages[safeIndex];

  if (pages.length === 0) {
    return (
      <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
        {generating ? (
          <ArtifactCenteredState
            icon={<Loader2 size={20} className="animate-spin" />}
            text="Creating pages…"
          />
        ) : (
          <ArtifactCenteredState icon={<Layers size={20} />} text="No pages yet." />
        )}
      </div>
    );
  }

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <div className="shrink-0 border-b border-app-bg-3/40 px-3 py-2">
        <div className="minimal-scrollbar flex gap-2 overflow-x-auto pb-1">
          {pages.map((page, index) => {
            const active = index === safeIndex;

            return (
              <button
                // No page id, so key by content; stable when a replace reorders the list.
                key={`${page.title}:${page.html.length}`}
                type="button"
                aria-current={active ? "true" : undefined}
                onClick={() => onPageIndexChange(index)}
                className={cn(
                  "w-[84px] shrink-0 rounded-xl border p-1 text-left transition-colors",
                  active
                    ? "border-app-fg-3 bg-app-bg-a2"
                    : "border-app-bg-3/60 bg-app-bg-a2/40 hover:bg-app-bg-a2",
                )}
              >
                <div className="overflow-hidden rounded-lg bg-white">
                  <ArtifactPageFrame
                    html={page.html}
                    title={`${page.title || `Page ${index + 1}`} thumbnail`}
                    format={format}
                    className="rounded-lg shadow-none"
                  />
                </div>
                <div className="mt-1 truncate text-[10px] text-app-fg-4">
                  {page.title || `Page ${index + 1}`}
                </div>
              </button>
            );
          })}
          {generating ? (
            <div className="grid w-[84px] shrink-0 place-items-center rounded-xl border border-dashed border-app-bg-3/60 bg-app-bg-a2/30 p-1">
              <Loader2 size={14} className="animate-spin text-app-fg-4" />
            </div>
          ) : null}
        </div>
      </div>

      <div className="minimal-scrollbar flex-1 overflow-y-auto p-4">
        <div className={cn("mx-auto w-full", pageClassName)}>
          <button
            type="button"
            onClick={onPresent ?? undefined}
            aria-label="Present fullscreen"
            className={cn("block w-full", onPresent ? "cursor-zoom-in" : "cursor-default")}
          >
            {current ? (
              <ArtifactPageFrame
                html={current.html}
                title={current.title || `Page ${safeIndex + 1}`}
                format={format}
                className="ring-1 ring-app-bg-3/60"
              />
            ) : null}
          </button>
          <div className="mt-2 flex items-center justify-between text-[12px] text-app-fg-4">
            <span className="truncate">{current?.title || `Page ${safeIndex + 1}`}</span>
            <span className="tabular-nums">
              {safeIndex + 1} / {pages.length}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
