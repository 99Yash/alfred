import { Link } from "@tanstack/react-router";
import {
  FileSpreadsheet,
  FileText,
  MoreHorizontal,
  Presentation,
  Star,
  type LucideIcon,
} from "lucide-react";
import { ArtifactPageFrame } from "~/components/artifact-page-frame";
import type { ArtifactType, LibraryArtifact } from "~/lib/library-artifacts";
import { cn } from "~/lib/utils";

const TYPE_TINT: Record<
  ArtifactType,
  { bg: string; fg: string; ring: string; icon: LucideIcon }
> = {
  document: {
    bg: "bg-vs-blue-1",
    fg: "text-vs-blue-4",
    ring: "ring-vs-blue-2",
    icon: FileText,
  },
  pdf: { bg: "bg-vs-red-1", fg: "text-vs-red-4", ring: "ring-vs-red-2", icon: FileText },
  presentation: {
    bg: "bg-vs-amber-1",
    fg: "text-vs-amber-4",
    ring: "ring-vs-amber-2",
    icon: Presentation,
  },
  spreadsheet: {
    bg: "bg-vs-green-1",
    fg: "text-vs-green-4",
    ring: "ring-vs-green-2",
    icon: FileSpreadsheet,
  },
};

export function ArtifactCard({
  artifact,
  index,
}: {
  artifact: LibraryArtifact;
  index: number;
}) {
  const tint = TYPE_TINT[artifact.type];
  const Icon = tint.icon;
  return (
    <Link
      to="/preview/library/$artifact"
      params={{ artifact: artifact.id }}
      className={cn(
        "group block overflow-hidden rounded-2xl bg-vs-bg-1 vs-card-in",
        "shadow-[0_1px_1px_rgba(0,0,0,0.05),0_0_0_1px_rgba(0,0,0,0.05)]",
        "transition-shadow vs-press",
        "hover:shadow-[0_4px_12px_rgba(0,0,0,0.08),0_0_0_1px_rgba(0,0,0,0.08)]",
        "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-4 focus-visible:ring-offset-vs-background",
      )}
      style={{ animationDelay: `${index * 60 + 160}ms` }}
    >
      <div className="aspect-[4/3] bg-vs-bg-2/60 p-4 shadow-[inset_0_-1px_0_rgba(0,0,0,0.05)]">
        {artifact.pages[0]?.html ? (
          <ArtifactPageFrame
            html={artifact.pages[0].html}
            title={`${artifact.title} cover preview`}
            className="mx-auto h-full max-w-[210px] rounded-lg shadow-[0_4px_12px_rgba(0,0,0,0.10)]"
          />
        ) : (
          <div
            className={cn(
              "mx-auto flex h-full max-w-[210px] flex-col rounded-lg p-4 text-vs-fg-4",
              "shadow-[0_4px_12px_rgba(0,0,0,0.10),0_0_0_1px_rgba(0,0,0,0.05)]",
              "bg-vs-bg-1",
            )}
          >
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-vs-fg-2">
              {artifact.pages[0]?.kicker}
            </p>
            <p className="mt-3 text-lg font-semibold leading-5 text-vs-fg-4">
              {artifact.pages[0]?.title}
            </p>
            <p className="mt-3 line-clamp-5 text-[11px] leading-4 text-vs-fg-3">
              {artifact.pages[0]?.body}
            </p>
          </div>
        )}
      </div>
      <div className="flex items-start gap-3 p-4">
        <span
          aria-hidden
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-xl ring-1",
            tint.bg,
            tint.fg,
            tint.ring,
          )}
        >
          <Icon size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-sm font-medium text-vs-fg-4">{artifact.title}</p>
            {artifact.favourite ? (
              <Star
                size={12}
                aria-hidden
                className="shrink-0 fill-vs-amber-4 text-vs-amber-4"
              />
            ) : null}
          </div>
          <p className="mt-0.5 truncate text-[12px] text-vs-fg-3">
            {artifact.typeLabel} · {artifact.updatedLabel}
          </p>
        </div>
        <span
          aria-hidden
          className="grid size-8 shrink-0 place-items-center rounded-xl text-vs-fg-2 transition-colors group-hover:text-vs-fg-4"
        >
          <MoreHorizontal size={16} />
        </span>
      </div>
    </Link>
  );
}
