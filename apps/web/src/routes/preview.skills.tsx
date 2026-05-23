import {
  createFileRoute,
  Link,
  Outlet,
  useChildMatches,
} from "@tanstack/react-router";
import { Plus, Sparkles, type LucideIcon } from "lucide-react";
import { VsButton, VsPill } from "~/components/ui/visitors";
import {
  PREVIEW_SKILLS,
  type PreviewSkill,
  type PreviewSkillTint,
} from "~/lib/preview-skills";
import { cn } from "~/lib/utils";

/**
 * Visitors-now-grammar port of /skills.
 *
 * The dimension version subscribes to Replicache + POSTs through Eden
 * to create a draft. This preview uses fixture skills + a no-op CTA so
 * the visual language can be reviewed without auth or sync state.
 *
 * Each skill row gets a tinted icon tile (cycling through the 4
 * visitors hues) so the list reads as a small collection rather than
 * a wall of identical cards.
 */
export const Route = createFileRoute("/preview/skills")({
  component: PreviewSkillsRoute,
});

function PreviewSkillsRoute() {
  const hasChild = useChildMatches().length > 0;
  return hasChild ? <Outlet /> : <PreviewSkillsPage />;
}

const TINT: Record<
  PreviewSkillTint,
  { bg: string; fg: string; ring: string; pillTone: "purple" | "sky" | "amber" | "green" }
> = {
  violet: {
    bg: "bg-vs-purple-1",
    fg: "text-vs-purple-4",
    ring: "ring-vs-purple-2",
    pillTone: "purple",
  },
  sky: { bg: "bg-vs-sky-1", fg: "text-vs-sky-4", ring: "ring-vs-sky-2", pillTone: "sky" },
  amber: {
    bg: "bg-vs-amber-1",
    fg: "text-vs-amber-4",
    ring: "ring-vs-amber-2",
    pillTone: "amber",
  },
  emerald: {
    bg: "bg-vs-green-1",
    fg: "text-vs-green-4",
    ring: "ring-vs-green-2",
    pillTone: "green",
  },
};

function PreviewSkillsPage() {
  const sorted = PREVIEW_SKILLS.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return (
    <div className="flex-1 min-w-0 overflow-y-auto vs-scrollbar">
      <main className="mx-auto w-full max-w-3xl px-4 sm:px-6 lg:px-8 py-12 sm:py-16">
        <header className="text-center space-y-3 max-w-2xl mx-auto vs-card-in">
          <h1 className="text-[40px] leading-[48px] font-medium tracking-tight text-vs-fg-4">
            Skills
          </h1>
          <p className="text-sm text-vs-fg-3">
            Long-lived prompts Alfred internalizes: preferences, biographical facts,
            working styles.
          </p>
          <div className="pt-3 flex justify-center">
            <VsButton variant="primary" size="lg" leading={<Plus size={14} />}>
              Create skill
            </VsButton>
          </div>
        </header>

        <section
          className="mt-12 space-y-3 vs-card-in"
          style={{ animationDelay: "120ms" }}
        >
          <div className="flex items-baseline gap-2 px-1">
            <h2 className="text-[15px] font-medium text-vs-fg-4">Your skills</h2>
            <span className="text-xs text-vs-fg-2 tabular-nums">{sorted.length}</span>
          </div>
          <ul className="flex flex-col gap-2">
            {sorted.map((skill, i) => (
              <li key={skill.slug}>
                <SkillRow skill={skill} index={i} />
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}

function SkillRow({ skill, index }: { skill: PreviewSkill; index: number }) {
  const tint = TINT[skill.tint];
  const Icon: LucideIcon = Sparkles;
  return (
    <Link
      to="/preview/skills/$slug"
      params={{ slug: skill.slug }}
      className={cn(
        "block rounded-2xl",
        "vs-card-in",
        "outline-none focus-visible:ring-2 focus-visible:ring-vs-purple-2 focus-visible:ring-offset-4 focus-visible:ring-offset-vs-background",
      )}
      style={{ animationDelay: `${index * 60 + 160}ms` }}
    >
      <div
        className={cn(
          "group relative flex items-center gap-3 rounded-2xl bg-vs-bg-1 p-4",
          "shadow-[0_1px_1px_rgba(0,0,0,0.05),0_0_0_1px_rgba(0,0,0,0.05)]",
          "transition-shadow vs-press",
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
            <p className="truncate text-sm font-medium text-vs-fg-4">{skill.name}</p>
            <code className="font-mono text-[11.5px] text-vs-fg-2">/{skill.slug}</code>
          </div>
          <p className="mt-0.5 line-clamp-1 text-xs text-vs-fg-3">{skill.description}</p>
        </div>
        <div className="hidden sm:flex shrink-0 flex-col items-end gap-1.5">
          {skill.status === "active" ? (
            <VsPill tone="green">Active</VsPill>
          ) : (
            <VsPill>Draft</VsPill>
          )}
          <span className="text-[11px] text-vs-fg-2 tabular-nums">
            {skill.lastRunAt ? `Ran ${formatRelative(skill.lastRunAt)}` : "Not yet learned"}
          </span>
        </div>
      </div>
    </Link>
  );
}

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
