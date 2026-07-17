import type { SyncedArtifact } from "@alfred/sync";
import { Ellipsis, PanelLeft, PanelRight, Share2 } from "lucide-react";
import { useSidebarState } from "~/lib/shell/app-shell";
import { cn } from "~/lib/utils";
import { ArtifactMenu } from "./artifact-menu";
import { IconButton } from "./rail/icon-button";
import { Tip } from "./tip";

export function TopBar({
  title,
  railOpen,
  onToggleRail,
  artifacts,
  selectedArtifactId,
  onOpenArtifact,
  onCloseArtifact,
}: {
  title: string;
  railOpen: boolean;
  onToggleRail: () => void;
  artifacts: SyncedArtifact[];
  selectedArtifactId: string | null;
  onOpenArtifact: (artifactId: string) => void;
  onCloseArtifact: () => void;
}) {
  const { open: sidebarOpen, setOpen: setSidebarOpen } = useSidebarState();
  return (
    <header
      className={cn(
        "app-frost-header sticky top-0 z-10",
        "flex h-14 shrink-0 items-center justify-between gap-3 px-5",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {!sidebarOpen ? (
          <IconButton label="Open sidebar" onClick={() => setSidebarOpen(true)}>
            <PanelLeft size={14} />
          </IconButton>
        ) : null}
        <h1 className="truncate text-sm font-medium text-app-fg-4">{title}</h1>
      </div>
      <div className="flex items-center gap-1.5">
        <Tip label="Share thread">
          <IconButton label="Share thread">
            <Share2 size={14} />
          </IconButton>
        </Tip>
        <Tip label="Thread settings">
          <IconButton label="Thread settings">
            <Ellipsis size={14} />
          </IconButton>
        </Tip>
        <span aria-hidden className="mx-1 h-5 w-px bg-app-bg-3" />
        <ArtifactMenu
          artifacts={artifacts}
          selectedId={selectedArtifactId}
          onOpen={onOpenArtifact}
          onClose={onCloseArtifact}
        />
        <Tip label={railOpen ? "Hide today panel" : "Show today panel"}>
          <IconButton
            label={railOpen ? "Hide today panel" : "Show today panel"}
            onClick={onToggleRail}
            active={railOpen}
          >
            <PanelRight size={14} />
          </IconButton>
        </Tip>
      </div>
    </header>
  );
}
