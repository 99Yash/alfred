import { useAutoAnimate } from "@formkit/auto-animate/react";
import { CornerDownLeft, X } from "lucide-react";
import { cn } from "~/lib/utils";
import type { QueuedMessage } from "~/lib/chat/use-chat-queue";
import { splitQuote } from "../quote";

/**
 * Queued messages above the composer (#489), FIFO. Each can be removed before it sends,
 * or sent now (#490), which stops the reply and moves the message to the head.
 */
export function QueuedChips({
  items,
  onRemove,
  onSendNow,
}: {
  items: QueuedMessage[];
  onRemove: (id: string) => void;
  onSendNow?: ((id: string) => void) | undefined;
}) {
  const [listRef] = useAutoAnimate<HTMLDivElement>();

  if (items.length === 0) return null;

  return (
    <div ref={listRef} aria-label="Queued messages" className="flex flex-wrap gap-2 px-1 pb-2">
      {items.map((item) => {
        const preview = splitQuote(item.text).body.trim();
        // The chip truncates; the full text is sent.
        const shown = preview.length > 80 ? `${preview.slice(0, 80).trimEnd()}…` : preview;

        const label =
          shown ||
          (item.files.length > 0
            ? `${item.files.length} image${item.files.length > 1 ? "s" : ""}`
            : "Queued");

        const fileHint =
          item.files.length > 0
            ? ` · ${item.files.length} file${item.files.length > 1 ? "s" : ""}`
            : "";

        return (
          <div
            key={item.id}
            className={cn(
              "group inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1.5",
              "border-app-fg-a1/30 bg-app-bg-2 text-[13px] leading-none text-app-fg-3",
              "shadow-[0_1px_2px_rgba(0,0,0,0.04)]",
            )}
          >
            <span className="min-w-0 truncate">
              {label}
              {preview && fileHint ? fileHint : ""}
            </span>
            {onSendNow ? (
              <button
                type="button"
                aria-label={`Send now: ${label}`}
                title="Send now"
                onClick={() => onSendNow(item.id)}
                className={cn(
                  "inline-flex size-5 shrink-0 items-center justify-center rounded-full",
                  "bg-app-bg-a2 text-app-fg-3 transition-colors hover:bg-app-purple-1 hover:text-app-purple-4",
                  "app-focus",
                )}
              >
                <CornerDownLeft size={12} />
              </button>
            ) : null}
            <button
              type="button"
              aria-label={`Remove queued message: ${label}`}
              onClick={() => onRemove(item.id)}
              className={cn(
                "inline-flex size-5 shrink-0 items-center justify-center rounded-full",
                "bg-app-bg-a2 text-app-fg-3 transition-colors hover:bg-app-bg-3 hover:text-app-fg-4",
                "app-focus",
              )}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
