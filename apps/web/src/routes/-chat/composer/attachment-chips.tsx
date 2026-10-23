import { X } from "lucide-react";
import { AnimatePresence, m } from "motion/react";
import { cn } from "~/lib/utils";
import { useAttachmentLightbox } from "../attachment-lightbox";
import { useCollapseMotion } from "../motion";
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
  // Each chip fades and collapses its width, so the chips after it slide over.
  const chipMotion = useCollapseMotion("width");

  // Only images enter the preview; a PDF chip never does.
  const lightbox = useAttachmentLightbox(
    items.map((a) => ({
      key: a.key,
      src: a.previewUrl,
      name: a.file.name,
      mime: a.file.type,
      ready: true,
    })),
  );

  return (
    <>
      <div className="flex flex-wrap gap-2 px-1 pb-2">
        <AnimatePresence initial={false}>
          {items.map((a) => {
            const onOpen = lightbox.openerFor(a.key);

            const thumbnail = (
              <img src={a.previewUrl} alt={a.file.name} className="size-full object-cover" />
            );

            // The motion box collapses; the chip inside keeps its 64 px.
            return (
              <m.div key={a.key} {...chipMotion}>
                <div className="group relative size-16 overflow-hidden rounded-xl border border-app-fg-a1/40 bg-app-bg-2">
                  {/* Preview stays available while disabled: it only reads. */}
                  {onOpen ? (
                    <button
                      type="button"
                      aria-label={`Preview ${a.file.name}`}
                      onClick={onOpen}
                      className="app-focus-inset block size-full cursor-zoom-in"
                    >
                      {thumbnail}
                    </button>
                  ) : (
                    thumbnail
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
              </m.div>
            );
          })}
        </AnimatePresence>
      </div>
      {/* Outside the chip list, so the presence list only sees chips. */}
      {lightbox.preview}
    </>
  );
}
