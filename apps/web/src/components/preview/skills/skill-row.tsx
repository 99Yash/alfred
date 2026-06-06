import { Link } from "@tanstack/react-router";
import { Sparkles, type LucideIcon } from "lucide-react";
import { AppPill } from "~/components/ui/v2";
import type { PreviewSkill, PreviewSkillTint } from "~/lib/preview-skills";
import { cn } from "~/lib/utils";

const TINT: Record<
  PreviewSkillTint,
  { bg: string; fg: string; ring: string; pillTone: "purple" | "sky" | "amber" | "green" }
> = {
  violet: {
    bg: "bg-app-purple-1",
    fg: "text-app-purple-4",
    ring: "ring-app-purple-2",
    pillTone: "purple",
  },
  sky: { bg: "bg-app-sky-1", fg: "text-app-sky-4", ring: "ring-app-sky-2", pillTone: "sky" },
  amber: {
    bg: "bg-app-amber-1",
    fg: "text-app-amber-4",
    ring: "ring-app-amber-2",
    pillTone: "amber",
  },
  emerald: {
    bg: "bg-app-green-1",
    fg: "text-app-green-4",
    ring: "ring-app-green-2",
    pillTone: "green",
  },
};

function formatRelative(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / (60 * 1000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function SkillRow({ skill, index }: { skill: PreviewSkill; index: number }) {
  const tint = TINT[skill.tint];
  const Icon: LucideIcon = Sparkles;
  return (
    <Link
      to="/skills/$slug"
      params={{ slug: skill.slug }}
      className={cn(
        "block rounded-2xl",
        "app-card-in",
        "outline-none focus-visible:ring-2 focus-visible:ring-app-purple-2 focus-visible:ring-offset-4 focus-visible:ring-offset-app-background",
      )}
      style={{ animationDelay: `${index * 60 + 160}ms` }}
    >
      <div
        className={cn(
          "group relative flex items-center gap-3 rounded-2xl bg-app-bg-1 p-4",
          "shadow-[0_1px_1px_rgba(0,0,0,0.05),0_0_0_1px_rgba(0,0,0,0.05)]",
          "transition-shadow app-press",
          "hover:shadow-[0_2px_4px_rgba(0,0,0,0.07),0_0_0_1px_rgba(0,0,0,0.08)]",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "grid size-11 shrink-0 place-items-center rounded-xl ring-1",
            tint.bg,
            tint.fg,
            tint.ring,
          )}
        >
          <Icon size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <p className="truncate text-sm font-medium text-app-fg-4">{skill.name}</p>
            <code className="font-mono text-[11.5px] text-app-fg-2">/{skill.slug}</code>
          </div>
          <p className="mt-0.5 line-clamp-1 text-xs text-app-fg-3">{skill.description}</p>
        </div>
        <div className="hidden sm:flex shrink-0 flex-col items-end gap-1.5">
          {skill.status === "active" ? (
            <AppPill tone="green">Active</AppPill>
          ) : (
            <AppPill>Draft</AppPill>
          )}
          <span className="text-[11px] text-app-fg-2 tabular-nums">
            {skill.lastRunAt ? `Ran ${formatRelative(skill.lastRunAt)}` : "Not yet learned"}
          </span>
        </div>
      </div>
    </Link>
  );
}
