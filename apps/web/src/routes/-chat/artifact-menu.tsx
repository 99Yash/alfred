import type { SyncedArtifact } from "@alfred/sync";
import { Files, Loader2 } from "lucide-react";
import { ARTIFACT_KIND_ICON, artifactTypeLabel } from "~/lib/artifacts/artifact-type";
import { cn } from "~/lib/utils";
import { PickerMenu, PickerMenuItem } from "./picker-menu";
import { IconButton } from "./rail/icon-button";
import { Tip } from "./tip";

// Top-bar artifact access (ADR-0075): nothing for 0, a toggle for 1, a count and picker for 2+.

function artifactIcon(artifact: SyncedArtifact, size: number) {
  if (artifact.status === "generating") return <Loader2 size={size} className="animate-spin" />;

  const KindIcon = ARTIFACT_KIND_ICON[artifact.kind];

  return <KindIcon size={size} />;
}

function artifactSubtitle(artifact: SyncedArtifact): string {
  if (artifact.status === "generating") return "Generating…";

  if (artifact.status === "error") return "Failed to generate";

  return artifactTypeLabel(artifact);
}

export function ArtifactMenu({
  artifacts,
  selectedId,
  onOpen,
  onClose,
}: {
  artifacts: SyncedArtifact[];
  selectedId: string | null;
  onOpen: (artifactId: string) => void;
  onClose: () => void;
}) {
  const [only] = artifacts;

  if (!only) return null;

  if (artifacts.length === 1) {
    const active = selectedId === only.id;

    return (
      <Tip label={active ? "Hide artifact" : `Open ${only.title}`}>
        <IconButton
          label={active ? "Hide artifact" : `Open artifact: ${only.title}`}
          active={active}
          onClick={() => (active ? onClose() : onOpen(only.id))}
        >
          {artifactIcon(only, 14)}
        </IconButton>
      </Tip>
    );
  }

  // "Active" when one of this thread's artifacts is open.
  const panelShowsArtifact = artifacts.some((a) => a.id === selectedId);

  // A radio menu: the panel shows at most one artifact, and its row carries the check.
  // No artifact id is empty, so `""` checks no row when the panel shows none of these.
  return (
    <PickerMenu
      label="Artifacts"
      value={selectedId ?? ""}
      tip="View artifacts"
      side="bottom"
      align="end"
      trigger={
        <button
          type="button"
          aria-label={`Artifacts (${artifacts.length})`}
          className={cn(
            "app-press inline-flex h-8 items-center gap-1.5 rounded-control px-2 text-[13px] font-medium",
            "transition-colors outline-none",
            "focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-2 focus-visible:ring-offset-app-background",
            panelShowsArtifact
              ? "bg-app-bg-2 text-app-fg-4 hover:bg-app-bg-a2"
              : "text-app-fg-3 hover:bg-app-bg-a2 hover:text-app-fg-4",
            "data-[state=open]:bg-app-bg-a2 data-[state=open]:text-app-fg-4",
          )}
        >
          <Files size={14} />
          {/* Keyed by the count, so a new artifact replays the pop. */}
          <span
            key={artifacts.length}
            className="tabular-nums motion-safe:animate-[app-count-pop_220ms_cubic-bezier(0.22,1,0.36,1)_backwards]"
          >
            {artifacts.length}
          </span>
        </button>
      }
    >
      {artifacts.map((artifact) => (
        <PickerMenuItem
          key={artifact.id}
          value={artifact.id}
          label={artifact.title}
          description={artifactSubtitle(artifact)}
          truncate
          icon={
            <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-control-sm bg-app-bg-1 text-app-fg-3">
              {artifactIcon(artifact, 15)}
            </span>
          }
          onSelect={() => onOpen(artifact.id)}
        />
      ))}
    </PickerMenu>
  );
}
