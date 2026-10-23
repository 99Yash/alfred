/**
 * Full-screen preview for the images of one message or one staged composer list.
 * Composes Radix Dialog primitives itself: `DialogContent` always adds a `frost-popover` panel.
 */

import * as RadixDialog from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, ExternalLink, X } from "lucide-react";
import {
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type SetStateAction,
} from "react";
import { ArtifactIconButton } from "~/components/artifacts/artifact-icon-button";
import { cn } from "~/lib/utils";

/** One image the lightbox can show. */
export interface LightboxImage {
  /** Attachment id (sent) or staging key (composer). */
  key: string;
  src: string;
  name: string;
}

const FADE = cn(
  "data-[state=open]:animate-[dialog-overlay-in_180ms_cubic-bezier(0.2,0,0,1)]",
  "data-[state=closed]:animate-[dialog-overlay-out_140ms_cubic-bezier(0.2,0,0,1)]",
  "motion-reduce:animate-none",
);

/** Full-screen image preview. `index === null` is closed. */
export function AttachmentLightbox({
  images,
  index,
  onIndexChange,
}: {
  images: readonly LightboxImage[];
  index: number | null;
  onIndexChange: Dispatch<SetStateAction<number | null>>;
}): ReactElement {
  const contentRef = useRef<HTMLDivElement | null>(null);
  // Keyed by `src`, so the next image starts without the error line.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  const open = index !== null && images.length > 0;
  // Clamp: the list can shrink while open (a row re-syncs, a staged file is replaced).
  const shown = open ? Math.max(0, Math.min(index, images.length - 1)) : 0;
  const image = images[shown];
  const multiple = images.length > 1;

  const go = (step: -1 | 1) => {
    onIndexChange(Math.max(0, Math.min(shown + step, images.length - 1)));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      go(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      go(1);
    }
  };

  // Only a click on the bare backdrop closes; the image and the controls do not.
  const onBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onIndexChange(null);
  };

  return (
    <RadixDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onIndexChange(null);
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay
          className={cn("fixed inset-0 z-100 bg-black/70 backdrop-blur-[2px]", FADE)}
        />
        <RadixDialog.Content
          ref={contentRef}
          onOpenAutoFocus={(event) => {
            // Focus the surface, not the first link, so no focus ring shows on open.
            event.preventDefault();
            contentRef.current?.focus();
          }}
          onKeyDown={onKeyDown}
          onClick={onBackdropClick}
          className={cn(
            "fixed inset-0 z-101 flex flex-col items-center justify-center gap-3 p-6 focus:outline-none",
            FADE,
          )}
        >
          {image ? (
            <>
              <RadixDialog.Title className="sr-only">{image.name}</RadixDialog.Title>
              <RadixDialog.Description className="sr-only">
                Image preview. Use the arrow keys to see the other images.
              </RadixDialog.Description>

              <div className="absolute top-3 right-3 flex items-center gap-1">
                <a
                  href={image.src}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Open in new tab"
                  title="Open in new tab"
                  className="grid size-7 shrink-0 place-items-center rounded-lg text-white/70 transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:outline-none"
                >
                  <ExternalLink size={15} />
                </a>
                <ArtifactIconButton
                  tone="dark"
                  label="Close preview"
                  onClick={() => onIndexChange(null)}
                >
                  <X size={16} />
                </ArtifactIconButton>
              </div>

              {failedSrc === image.src ? (
                <p className="text-sm text-white/70">Couldn't load this image.</p>
              ) : (
                <img
                  key={image.src}
                  src={image.src}
                  alt={image.name}
                  className="max-h-[80vh] max-w-[90vw] rounded-xl object-contain shadow-2xl"
                  onError={() => setFailedSrc(image.src)}
                />
              )}

              <div className="flex items-center gap-3">
                {multiple ? (
                  <LightboxNavButton side="left" disabled={shown === 0} onClick={() => go(-1)} />
                ) : null}
                <div className="flex max-w-60 items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs text-white/80">
                  <span className="truncate">{image.name}</span>
                  {multiple ? (
                    <span className="shrink-0 text-white/50 tabular-nums">
                      {shown + 1} / {images.length}
                    </span>
                  ) : null}
                </div>
                {multiple ? (
                  <LightboxNavButton
                    side="right"
                    disabled={shown >= images.length - 1}
                    onClick={() => go(1)}
                  />
                ) : null}
              </div>
            </>
          ) : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** Prev/next with a `-m-3 p-3` hit buffer, so a near miss does not close the preview. */
function LightboxNavButton({
  side,
  disabled,
  onClick,
}: {
  side: "left" | "right";
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <span className="-m-3 p-3">
      <button
        type="button"
        aria-label={side === "left" ? "Previous image" : "Next image"}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          "grid size-8 place-items-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20",
          "focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:outline-none",
          "disabled:cursor-not-allowed disabled:opacity-30",
        )}
      >
        {side === "left" ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
      </button>
    </span>
  );
}
