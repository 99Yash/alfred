import type { SyncedArtifact } from "@alfred/sync";
import { ArrowRight, Loader2 } from "lucide-react";
import { ARTIFACT_KIND_ICON, artifactTypeLabel } from "~/lib/artifacts/artifact-type";
import { cn } from "~/lib/utils";

/** Card under the authoring message that opens the artifact in the sidebar (ADR-0075 Phase 3). */
export function ArtifactTriggerCard({
  artifact,
  active,
  onOpen,
}: {
  artifact: SyncedArtifact;
  active: boolean;
  onOpen: (artifactId: string) => void;
}) {
  const KindIcon = ARTIFACT_KIND_ICON[artifact.kind];
  const externalFile = artifact.content?.kind === "external_file" ? artifact.content : null;
  // An external file is complete at mint; `generating` is only for the messageId backfill.
  const generating = artifact.status === "generating" && !externalFile;
  const pageCount = artifact.content?.kind === "pages" ? artifact.content.pages.length : undefined;

  // An external file is never `generating` here, so it reads "Google Drive file".
  const subtitle = generating
    ? pageCount !== undefined
      ? `Generating · ${pageCount} ${pageCount === 1 ? "page" : "pages"}`
      : "Generating…"
    : artifactTypeLabel(artifact);

  return (
    <button
      type="button"
      onClick={() => onOpen(artifact.id)}
      aria-label={`Open artifact: ${artifact.title}`}
      className={cn(
        // Tailwind v4 lifts with the CSS `translate` property, so transition `translate`.
        "group flex w-full items-center gap-3 rounded-surface border px-3 py-2.5 text-left transition-[background-color,border-color,box-shadow,translate] duration-200",
        active
          ? "border-app-fg-3 bg-app-bg-a2"
          : "border-app-bg-3/60 bg-app-bg-a2/40 hover:-translate-y-px hover:border-app-bg-3 hover:bg-app-bg-a2 hover:shadow-[0_2px_10px_rgba(0,0,0,0.05)]",
      )}
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-control bg-app-bg-1 text-app-fg-3 shadow-[0_0_0_1px_rgba(0,0,0,0.04)]">
        {generating ? <Loader2 size={16} className="animate-spin" /> : <KindIcon size={16} />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-app-fg-4">{artifact.title}</p>
        <p className="truncate text-[12px] text-app-fg-3">{subtitle}</p>
      </div>
      <span className="flex shrink-0 items-center gap-1 text-[12px] text-app-fg-3 transition-colors group-hover:text-app-fg-4">
        {active ? "Viewing" : "Open"}
        <ArrowRight size={13} className="transition-[translate] group-hover:translate-x-0.5" />
      </span>
    </button>
  );
}
