import { Plus } from "lucide-react";
import { AppButton } from "~/components/ui/v2";
import { SKILL_FIXTURES } from "~/lib/skills";
import { SkillRow } from "./skill-row";

// Hoisted so AppButton doesn't see a fresh JSX node every render.
const CREATE_SKILL_LEADING = <Plus size={14} />;

export function SkillsPage() {
  const sorted = SKILL_FIXTURES.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return (
    <div className="scroll-stable min-w-0 flex-1 overflow-y-auto">
      <main className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 sm:py-16 lg:px-8">
        <header className="app-card-in mx-auto max-w-2xl space-y-3 text-center">
          <h1 className="text-[40px] leading-[48px] font-medium tracking-[-0.04em] text-app-fg-4">
            Skills
          </h1>
          <p className="text-sm text-app-fg-3">
            Long-lived prompts Alfred internalizes: preferences, biographical facts, working styles.
          </p>
          <div className="flex justify-center pt-3">
            <AppButton variant="primary" size="lg" leading={CREATE_SKILL_LEADING}>
              Create skill
            </AppButton>
          </div>
        </header>

        <section className="app-card-in mt-12 space-y-3" style={{ animationDelay: "120ms" }}>
          <div className="flex items-baseline gap-2 px-1">
            <h2 className="text-[15px] font-medium text-app-fg-4">Your skills</h2>
            <span className="text-xs text-app-fg-2 tabular-nums">{sorted.length}</span>
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
