import type { SyncedArtifact } from "@alfred/sync";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  FileSpreadsheet,
  FileText,
  Loader2,
  Presentation,
  type LucideIcon,
} from "lucide-react";
import { ArtifactPageFrame } from "~/components/artifact-page-frame";
import { artifactType, artifactTypeLabel, type ArtifactType } from "~/lib/artifacts/artifact-type";
import { cn } from "~/lib/utils";
import { formatArtifactDate } from "./helpers";

const TYPE_TINT = {
  document: {
    bg: "bg-app-blue-1",
    fg: "text-app-blue-4",
    ring: "ring-app-blue-2",
    icon: FileText,
  },
  pdf: { bg: "bg-app-red-1", fg: "text-app-red-4", ring: "ring-app-red-2", icon: FileText },
  slides: {
    bg: "bg-app-amber-1",
    fg: "text-app-amber-4",
    ring: "ring-app-amber-2",
    icon: Presentation,
  },
  spreadsheet: {
    bg: "bg-app-orange-1",
    fg: "text-app-orange-4",
    ring: "ring-app-orange-2",
    icon: FileSpreadsheet,
  },
  external_file: {
    bg: "bg-app-green-1",
    fg: "text-app-green-4",
    ring: "ring-app-green-2",
    icon: FileText,
  },
} satisfies Record<ArtifactType, { bg: string; fg: string; ring: string; icon: LucideIcon }>;

export function ArtifactCard({ artifact, index }: { artifact: SyncedArtifact; index: number }) {
  const type = artifactType(artifact);
  const tint = TYPE_TINT[type];
  const Icon = tint.icon;
  const firstPage = artifact.content?.kind === "pages" ? artifact.content.pages[0] : undefined;
  const markdown = artifact.content?.kind === "document" ? artifact.content.markdown : "";

  return (
    <Link
      to="/library/$artifact"
      params={{ artifact: artifact.id }}
      className={cn(
        "group app-card-in block overflow-hidden rounded-surface bg-app-bg-1",
        "shadow-[0_1px_1px_rgba(0,0,0,0.05),0_0_0_1px_rgba(0,0,0,0.05)]",
        "app-press transition-shadow",
        "hover:shadow-[0_4px_12px_rgba(0,0,0,0.08),0_0_0_1px_rgba(0,0,0,0.08)]",
        "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-4 focus-visible:ring-offset-app-background",
      )}
      style={{ animationDelay: `${index * 60 + 160}ms` }}
    >
      <div className="aspect-4/3 bg-app-bg-2/60 p-4 shadow-[inset_0_-1px_0_rgba(0,0,0,0.05)]">
        {firstPage ? (
          <ArtifactPageFrame
            html={firstPage.html}
            title={`${artifact.title} cover preview`}
            format={artifact.format ?? "pdf"}
            className="mx-auto h-full max-w-[210px] rounded-control shadow-[0_4px_12px_rgba(0,0,0,0.10)]"
          />
        ) : (
          <div
            className={cn(
              "mx-auto flex h-full max-w-[210px] flex-col rounded-control p-4 text-app-fg-4",
              "shadow-[0_4px_12px_rgba(0,0,0,0.10),0_0_0_1px_rgba(0,0,0,0.05)]",
              "bg-app-bg-1",
            )}
          >
            <p className="text-lg leading-5 font-semibold text-app-fg-4">{artifact.title}</p>
            {markdown ? (
              <p className="mt-3 line-clamp-6 text-[11px] leading-4 whitespace-pre-wrap text-app-fg-3">
                {markdown}
              </p>
            ) : (
              <div className="grid flex-1 place-items-center text-app-fg-3">
                {artifact.status === "generating" ? (
                  <Loader2 size={18} className="animate-spin" />
                ) : artifact.status === "error" ? (
                  <AlertTriangle size={18} />
                ) : (
                  <FileText size={18} />
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="flex items-start gap-3 p-4">
        <span
          aria-hidden
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-control ring-1",
            tint.bg,
            tint.fg,
            tint.ring,
          )}
        >
          <Icon size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-app-fg-4">{artifact.title}</p>
          <p className="mt-0.5 truncate text-[12px] text-app-fg-3">
            {artifactTypeLabel(artifact)} · {formatArtifactDate(artifact)}
          </p>
        </div>
      </div>
    </Link>
  );
}
