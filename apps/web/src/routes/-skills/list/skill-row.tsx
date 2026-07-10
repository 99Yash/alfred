import { Link } from "@tanstack/react-router";
import type { SyncedSkill } from "@alfred/sync";
import { Sparkles } from "lucide-react";
import { AppPill } from "~/components/ui/v2";
import { formatRelative } from "~/lib/strings";
import { cn } from "~/lib/utils";

export function SkillRow({ skill, index }: { skill: SyncedSkill; index: number }) {
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
          "app-press transition-shadow",
          "hover:shadow-[0_2px_4px_rgba(0,0,0,0.07),0_0_0_1px_rgba(0,0,0,0.08)]",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "grid size-11 shrink-0 place-items-center rounded-xl ring-1",
            "bg-app-purple-1 text-app-purple-4 ring-app-purple-2",
          )}
        >
          <Sparkles size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <p className="truncate text-sm font-medium text-app-fg-4">{skill.name}</p>
            <code className="font-mono text-[11.5px] text-app-fg-2">/{skill.slug}</code>
          </div>
          <p className="mt-0.5 line-clamp-1 text-xs text-app-fg-3">
            {skill.description ?? "Ready to learn."}
          </p>
        </div>
        <div className="hidden shrink-0 flex-col items-end gap-1.5 sm:flex">
          {skill.status === "active" ? (
            <AppPill tone="green">Active</AppPill>
          ) : (
            <AppPill>Draft</AppPill>
          )}
          <span className="text-[11px] text-app-fg-2 tabular-nums">
            {skill.lastInvokedAt ? `Ran ${formatRelative(skill.lastInvokedAt)}` : "Not yet learned"}
          </span>
        </div>
      </div>
    </Link>
  );
}
