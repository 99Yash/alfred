import { isPassThrough } from "@alfred/contracts";
import { X } from "lucide-react";
import { cn } from "~/lib/utils";
import { AttachmentFileTile } from "../attachment-file-tile";
import { useAttachmentLightbox } from "../attachment-lightbox";
import { CollapseItem, CollapseList } from "../collapse-list";
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
  // Only images enter the preview; a PDF or text chip never does.
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
      <CollapseList axis="width" className="flex flex-wrap gap-2 px-1 pb-2">
        {items.map((a) => {
          const onOpen = lightbox.openerFor(a.key);

          // A PDF or text file has no image to show, so it gets a file face.
          const thumbnail = isPassThrough(a.file.type) ? (
            <img src={a.previewUrl} alt={a.file.name} className="size-full object-cover" />
          ) : (
            <AttachmentFileTile name={a.file.name} compact />
          );

          // The motion box collapses; the chip inside keeps its 64 px.
          return (
            <CollapseItem key={a.key}>
              <div className="group relative size-16 overflow-hidden rounded-surface border border-app-fg-a1/40 bg-app-bg-2">
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
            </CollapseItem>
          );
        })}
      </CollapseList>
      {/* Outside the list: every child of CollapseList becomes a presence row. */}
      {lightbox.preview}
    </>
  );
}
