import { Plus } from "lucide-react";
import { VsButton } from "~/components/ui/visitors";
import { PREVIEW_SKILLS } from "~/lib/preview-skills";
import { SkillRow } from "./skill-row";

// Hoisted so VsButton doesn't see a fresh JSX node every render.
const CREATE_SKILL_LEADING = <Plus size={14} />;

export function PreviewSkillsPage() {
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
            <VsButton variant="primary" size="lg" leading={CREATE_SKILL_LEADING}>
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
