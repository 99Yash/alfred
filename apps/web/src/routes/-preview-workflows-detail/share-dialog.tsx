import { Copy, Link2, Share2 } from "lucide-react";
import { useEffect, useEffectEvent } from "react";
import { VsButton } from "~/components/ui/visitors";
import { cn } from "~/lib/utils";
import type { WorkflowDefinition } from "~/lib/workflows";
import { WorkflowIcon } from "./workflow-icon";

const COPY_LEADING = <Copy size={13} />;

interface ShareDialogProps {
  workflow: WorkflowDefinition;
  open: boolean;
  onClose: () => void;
}

export function ShareDialog({ workflow, open, onClose }: ShareDialogProps) {
  const onCloseEvent = useEffectEvent(onClose);
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseEvent();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  if (!open) return null;

  return (
    <dialog
      open
      aria-modal="true"
      aria-label="Share workflow"
      className="fixed inset-0 z-[60] m-0 flex max-h-none max-w-none items-start justify-center border-0 bg-transparent p-0 pt-[14vh] vs-fade-in"
    >
      <button
        type="button"
        aria-label="Close share dialog"
        onClick={onClose}
        className="absolute inset-0 bg-vs-background/55 backdrop-blur-[2px]"
      />
      <div
        className={cn(
          "relative w-[min(520px,92vw)] rounded-2xl bg-vs-bg-1",
          "shadow-[0_24px_64px_rgba(0,0,0,0.18),0_0_0_1px_rgba(0,0,0,0.06)]",
        )}
      >
        <div className="px-6 pt-5 pb-2">
          <p className="text-sm font-medium text-vs-fg-4">Share workflow</p>
          <p className="mt-1 text-xs text-vs-fg-3">Copy a private link to this workflow preview.</p>
        </div>
        <div className="px-6 pb-6">
          <div className="rounded-2xl bg-vs-bg-2/60 shadow-[0_0_0_1px_rgba(0,0,0,0.05)] p-4">
            <div className="flex items-center gap-3">
              <WorkflowIcon tone="purple">
                <Share2 size={16} />
              </WorkflowIcon>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-vs-fg-4">{workflow.name}</p>
                <p className="truncate text-[12px] text-vs-fg-3">{workflow.description}</p>
              </div>
            </div>
            <div
              className={cn(
                "mt-4 flex items-center gap-2 rounded-xl bg-vs-bg-1 px-3 py-2",
                "shadow-[0_0_0_1px_rgba(0,0,0,0.05)]",
              )}
            >
              <Link2 size={14} className="shrink-0 text-vs-fg-2" />
              <p className="min-w-0 flex-1 truncate text-[12.5px] text-vs-fg-3">
                alfred.local/workflows/{workflow.id}
              </p>
              <VsButton variant="ghost" size="sm" leading={COPY_LEADING}>
                Copy
              </VsButton>
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <VsButton variant="white" size="md" onClick={onClose}>
              Close
            </VsButton>
          </div>
        </div>
      </div>
    </dialog>
  );
}
