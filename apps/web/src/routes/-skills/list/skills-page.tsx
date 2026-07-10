import { useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import { AppButton, AppCard } from "~/components/ui/v2";
import { responseErrorMessage } from "~/lib/api-error";
import { client } from "~/lib/eden";
import { useSkills } from "../use-skills";
import { SkillRow } from "./skill-row";

// Hoisted so AppButton doesn't see a fresh JSX node every render.
const CREATE_SKILL_LEADING = <Plus size={14} />;

export function SkillsPage() {
  const navigate = useNavigate();
  const { skills, loading, error, retry } = useSkills();
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const hasCachedSkills = skills.length > 0;

  const createSkill = async () => {
    if (creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const response = await client.api.skills.post({});
      if (response.error) {
        throw new Error(
          responseErrorMessage(response.error.value, response.error.status, "Create skill"),
        );
      }
      await navigate({ to: "/skills/$slug", params: { slug: response.data.slug } });
    } catch (caught) {
      setCreateError(caught instanceof Error ? caught.message : "Failed to create skill");
      setCreating(false);
    }
  };

  return (
    <div className="scroll-stable min-w-0 flex-1 overflow-y-auto">
      <main className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 sm:py-16 lg:px-8">
        <header className="app-card-in mx-auto max-w-2xl space-y-3 text-center">
          <h1 className="text-[40px] leading-[48px] font-medium tracking-[-0.04em] text-app-fg-4">
            Skills
          </h1>
          <p className="text-sm text-app-fg-3">
            Long-lived instructions Alfred internalizes: preferences, biographical facts, working
            styles.
          </p>
          <div className="flex justify-center pt-3">
            <AppButton
              variant="primary"
              size="lg"
              leading={CREATE_SKILL_LEADING}
              loading={creating}
              onClick={() => void createSkill()}
            >
              {creating ? "Creating…" : "Create skill"}
            </AppButton>
          </div>
          {createError ? <p className="text-xs text-app-red-4">{createError}</p> : null}
        </header>

        <section className="app-card-in mt-12 space-y-3" style={{ animationDelay: "120ms" }}>
          <div className="flex items-baseline gap-2 px-1">
            <h2 className="text-[15px] font-medium text-app-fg-4">Your skills</h2>
            <span className="text-xs text-app-fg-2 tabular-nums">{skills.length}</span>
          </div>
          {loading ? <SkillsLoading /> : null}
          {error && !hasCachedSkills ? (
            <AppCard className="flex flex-col items-center gap-3 px-6 py-10 text-center">
              <div>
                <p className="text-sm font-medium text-app-fg-4">Couldn’t load skills</p>
                <p className="mt-1 text-xs text-app-fg-3">{error}</p>
              </div>
              <AppButton size="sm" onClick={retry}>
                Retry
              </AppButton>
            </AppCard>
          ) : null}
          {error && hasCachedSkills ? (
            <AppCard className="flex items-center justify-between gap-4 px-4 py-3">
              <p className="text-xs text-app-fg-3">
                Showing cached skills. <span className="text-app-red-4">{error}</span>
              </p>
              <AppButton size="sm" onClick={retry}>
                Retry
              </AppButton>
            </AppCard>
          ) : null}
          {!loading && !error && !hasCachedSkills ? (
            <AppCard className="px-6 py-12 text-center">
              <p className="text-sm font-medium text-app-fg-4">No skills yet</p>
              <p className="mt-1 text-xs text-app-fg-3">
                Create a skill, then teach Alfred what it should remember.
              </p>
            </AppCard>
          ) : null}
          {!loading && hasCachedSkills ? (
            <ul className="flex flex-col gap-2">
              {skills.map((skill, index) => (
                <li key={skill.id}>
                  <SkillRow skill={skill} index={index} />
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </main>
    </div>
  );
}

function SkillsLoading() {
  return (
    <div className="space-y-2" aria-label="Loading skills">
      {[0, 1, 2].map((item) => (
        <div key={item} className="h-[76px] animate-pulse rounded-2xl bg-app-bg-2" />
      ))}
    </div>
  );
}
