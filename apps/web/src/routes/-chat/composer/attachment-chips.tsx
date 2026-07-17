import { AnimatePresence, m, useReducedMotion } from "framer-motion";
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
  // framer-motion honors the OS setting; when reduced, we skip the scale/pop and
  // let tiles appear/disappear instantly while still animating reflow position.
  const reduce = useReducedMotion();
  const enter = reduce ? { opacity: 1 } : { opacity: 1, scale: 1 };
  const leave = reduce ? { opacity: 0 } : { opacity: 0, scale: 0.8 };

  return (
    <div className="flex flex-wrap gap-2 px-1 pb-2">
      {/* `initial={false}` skips the mount-time enter so an existing draft's
       * attachments don't pop in on thread load — only newly added tiles animate. */}
      <AnimatePresence initial={false} mode="popLayout">
        {items.map((a) => (
          <m.div
            key={a.key}
            layout
            initial={leave}
            animate={enter}
            exit={leave}
            transition={{ type: "spring", stiffness: 500, damping: 34, mass: 0.6 }}
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
          </m.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
