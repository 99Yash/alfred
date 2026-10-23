import { isPassThrough } from "@alfred/contracts";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { X } from "lucide-react";
import { useState } from "react";
import { cn } from "~/lib/utils";
import { AttachmentLightbox, type LightboxImage } from "../attachment-lightbox";
import type { PendingAttachment } from "./use-composer-attachments";

/** Staged attachment previews above the editor. */
export function AttachmentChips({
  items,
  disabled,
  onRemove,
}: {
  items: PendingAttachment[];
  disabled?: boolean | undefined;
  onRemove: (key: string) => void;
}) {
  // auto-animate owns enter, exit, and reflow, and honors reduced motion.
  const [listRef] = useAutoAnimate<HTMLDivElement>();
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // Only images enter the preview; a PDF chip never does.
  const images: LightboxImage[] = items
    .filter((a) => isPassThrough(a.file.type))
    .map((a) => ({ key: a.key, src: a.previewUrl, name: a.file.name }));

  return (
    <>
      <div ref={listRef} className="flex flex-wrap gap-2 px-1 pb-2">
        {items.map((a) => {
          // Resolve by key, never by render position: the image list skips PDFs.
          const imageIndex = images.findIndex((i) => i.key === a.key);

          const thumbnail = (
            <img src={a.previewUrl} alt={a.file.name} className="size-full object-cover" />
          );

          return (
            <div
              key={a.key}
              className="group relative size-16 overflow-hidden rounded-xl border border-app-fg-a1/40 bg-app-bg-2"
            >
              {/* Preview stays available while disabled: it only reads. */}
              {imageIndex === -1 ? (
                thumbnail
              ) : (
                <button
                  type="button"
                  aria-label={`Preview ${a.file.name}`}
                  onClick={() => setLightboxIndex(imageIndex)}
                  className="block size-full cursor-zoom-in"
                >
                  {thumbnail}
                </button>
              )}
              <button
                type="button"
                aria-label={`Remove ${a.file.name}`}
                disabled={disabled}
                onClick={() => onRemove(a.key)}
                className={cn(
                  "absolute top-0.5 right-0.5 grid size-5 place-items-center rounded-full bg-app-background/80 text-app-fg-4 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100",
                  disabled &&
                    "cursor-not-allowed opacity-0 group-hover:opacity-0 focus-visible:opacity-0",
                )}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
      {/* Outside the auto-animate list, so the list only sees chips. */}
      <AttachmentLightbox images={images} index={lightboxIndex} onIndexChange={setLightboxIndex} />
    </>
  );
}
