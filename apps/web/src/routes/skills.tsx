import { IDB_KEY, type SyncedSkill } from "@alfred/sync";
import {
  createFileRoute,
  Link,
  Outlet,
  useChildMatches,
  useNavigate,
} from "@tanstack/react-router";
import { Loader2, Plus, Sparkles } from "lucide-react";
import { useState } from "react";
import type { ReadTransaction } from "replicache";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { authClient } from "~/lib/auth-client";
import { client, edenErrorMessage } from "~/lib/eden";
import { useReplicache } from "~/lib/replicache/context";
import { useSubscribe } from "~/lib/replicache/hooks";
import { SkillStatusPill } from "~/lib/skills-ui";

export const Route = createFileRoute("/skills")({
  component: SkillsRoute,
});

/**
 * `/skills` is the parent of `/skills/$slug` in TanStack's route tree, so its
 * component renders for both URLs. When a child route is matched (we're on
 * `/skills/$slug`) we hand the render off to the child via <Outlet />;
 * otherwise we render the list page.
 */
function SkillsRoute() {
  const hasChild = useChildMatches().length > 0;
  return hasChild ? <Outlet /> : <SkillsPage />;
}

const listSkills = async (tx: ReadTransaction): Promise<SyncedSkill[]> => {
  const entries = await tx
    .scan({ prefix: IDB_KEY.SKILL({}) })
    .entries()
    .toArray();
  return entries.map(([, v]) => v as unknown as SyncedSkill);
};

function SkillsPage() {
  const navigate = useNavigate();
  const { data: session } = authClient.useSession();
  const rep = useReplicache();
  const skills = useSubscribe(listSkills);

  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* Instant-nav: server lazily creates a draft (no name / no prompt required)
   * and we immediately route into its editor. Mirrors Dimension's pattern —
   * click 'Create Skill' and the editor opens; aborted drafts still persist. */
  const onCreate = async () => {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await client.api.skills.post({});
      if (res.error) {
        setError(edenErrorMessage(res.error, "Failed to create skill"));
        return;
      }
      /* Force a pull before navigating so the editor finds the new row in
       * Replicache's local cache on first render instead of flashing
       * "Skill not found" while the SSE poke flies. */
      if (rep) await rep.pull();
      await navigate({ to: "/skills/$slug", params: { slug: res.data.slug } });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create skill");
    } finally {
      setCreating(false);
    }
  };

  if (!session?.user) {
    return (
      <SkillsShell>
        <Card className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
          <span
            className="frost-icon-tile grid size-10 place-items-center rounded-xl text-gray-900"
            aria-hidden
          >
            <Sparkles size={18} />
          </span>
          <p className="text-sm font-medium text-gray-950">Not signed in</p>
          <p className="text-[12.5px] text-gray-800">Sign in to create and manage skills.</p>
          <a
            href="/login"
            className="mt-2 text-[12.5px] text-gray-900 underline underline-offset-4 hover:text-gray-1000"
          >
            Sign in
          </a>
        </Card>
      </SkillsShell>
    );
  }

  const sorted = [...(skills ?? [])].sort((a, b) =>
    (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt),
  );

  return (
    <SkillsShell>
      <div className="pt-2 flex justify-center">
        <Button
          variant="primary"
          size="lg"
          leading={creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          onClick={onCreate}
          disabled={creating}
        >
          {creating ? "Creating…" : "Create Skill"}
        </Button>
      </div>

      {error ? <p className="pt-3 text-center text-[12.5px] text-red-400">{error}</p> : null}

      <div className="mt-12 space-y-3">
        <h2 className="text-[15px] font-medium text-gray-1000">Your skills</h2>
        {skills === undefined ? (
          <p className="text-sm text-gray-800 px-1">Loading…</p>
        ) : sorted.length === 0 ? (
          <Card className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
            <span
              className="frost-icon-tile grid size-10 place-items-center rounded-xl text-gray-900"
              aria-hidden
            >
              <Sparkles size={18} />
            </span>
            <p className="text-sm font-medium text-gray-950">No skills yet</p>
            <p className="max-w-[28rem] text-[12.5px] text-gray-800">
              A skill is a long-lived prompt Alfred internalizes — preferences, biographical facts,
              working styles. Click <em>Create Skill</em> above to author your first.
            </p>
          </Card>
        ) : (
          <div className="flex flex-col gap-1">
            {sorted.map((skill) => (
              <SkillRow key={skill.id} skill={skill} />
            ))}
          </div>
        )}
      </div>
    </SkillsShell>
  );
}

/* -------------------------------------------------------------------------- */
/* Layout shell                                                               */
/* -------------------------------------------------------------------------- */

function SkillsShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
      <div className="md:hidden h-6" />

      <header className="space-y-4 text-center">
        <h1 className="heading-display text-[40px] leading-[48px] font-medium tracking-tight">
          Skills
        </h1>
        <p className="text-sm text-gray-800">
          Long-lived prompts Alfred internalizes — preferences, biographical facts, working styles.
        </p>
      </header>

      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Skill row card                                                             */
/* -------------------------------------------------------------------------- */

function SkillRow({ skill }: { skill: SyncedSkill }) {
  return (
    <Link
      to="/skills/$slug"
      params={{ slug: skill.slug }}
      className="block rounded-2xl outline-none focus-visible:outline-none"
    >
      <Card interactive className="flex items-center gap-3 px-3 py-2.5 text-gray-950">
        <span
          className="frost-icon-tile grid size-10 shrink-0 place-items-center rounded-xl text-gray-900"
          aria-hidden
        >
          <Sparkles size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-gray-950">{skill.name}</p>
          <p className="truncate text-[12.5px] text-gray-800 font-mono">
            /{skill.slug}
            {skill.description ? (
              <span className="ml-2 font-sans not-italic">· {skill.description}</span>
            ) : null}
          </p>
        </div>
        <SkillStatusPill status={skill.status} />
      </Card>
    </Link>
  );
}
