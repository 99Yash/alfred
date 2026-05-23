import { Ellipsis, PanelRight, Share2 } from "lucide-react";
import { VsPill } from "~/components/ui/visitors";
import { cn } from "~/lib/utils";
import { IconButton } from "./icon-button";

export function ThreadTopBar({
  title,
  railOpen,
  onToggleRail,
}: {
  title: string;
  railOpen: boolean;
  onToggleRail: () => void;
}) {
  return (
    <div
      className={cn(
        "vs-frost-header sticky top-0 z-30",
        "h-[58px] px-4 flex items-center justify-between gap-3",
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        <h1 className="text-sm font-medium tracking-tight text-vs-fg-4 truncate max-w-[42ch]">{title}</h1>
        <VsPill className="h-7 px-2 text-[12px]" tone="purple" variant="accent">
          Boss agent
        </VsPill>
      </div>

      <div className="flex items-center gap-1.5">
        <IconButton label="Share thread">
          <Share2 size={14} />
        </IconButton>
        <IconButton label="Thread settings">
          <Ellipsis size={14} />
        </IconButton>
        <span aria-hidden className="mx-1 h-5 w-px bg-vs-bg-3" />
        <IconButton
          label={railOpen ? "Hide today panel" : "Show today panel"}
          onClick={onToggleRail}
          active={railOpen}
        >
          <PanelRight size={14} />
        </IconButton>
      </div>
    </div>
  );
}
