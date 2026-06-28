import { Ellipsis, PanelRight, Share2 } from "lucide-react";
import { AppPill } from "~/components/ui/v2";
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
        "app-frost-header sticky top-0 z-30",
        "flex h-[58px] items-center justify-between gap-3 px-4",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <h1 className="max-w-[42ch] truncate text-sm font-medium tracking-tight text-app-fg-4">
          {title}
        </h1>
        <AppPill className="h-7 px-2 text-[12px]" tone="purple" variant="accent">
          Boss agent
        </AppPill>
      </div>

      <div className="flex items-center gap-1.5">
        <IconButton label="Share thread">
          <Share2 size={14} />
        </IconButton>
        <IconButton label="Thread settings">
          <Ellipsis size={14} />
        </IconButton>
        <span aria-hidden className="mx-1 h-5 w-px bg-app-bg-3" />
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
