import { X } from "lucide-react";
import { cn } from "~/lib/utils";
import type { PendingAttachment } from "./use-composer-attachments";

/** Inline preview row for staged attachments above the editor. */
export function AttachmentChips({
  items,
  disabled,
  onRemove,
}: {
  items: PendingAttachment[];
  disabled?: boolean;
  onRemove: (key: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2 px-1 pb-2">
      {items.map((a) => (
        <div
          key={a.key}
          className="group relative size-16 overflow-hidden rounded-xl border border-app-fg-a1/40 bg-app-bg-2"
        >
          <img src={a.previewUrl} alt={a.file.name} className="size-full object-cover" />
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
      ))}
    </div>
  );
}
