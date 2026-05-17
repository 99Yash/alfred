import { IDB_KEY, type SyncedSkill } from "@alfred/sync";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ChevronRight, Sparkles } from "lucide-react";
import { useState } from "react";
import type { ReadTransaction } from "replicache";
import { authClient } from "~/lib/auth-client";
import { client, edenErrorMessage } from "~/lib/eden";
import { useSubscribe } from "~/lib/replicache/hooks";
import { SkillStatusPill } from "~/lib/skills-ui";
import {
  Button,
  Card,
  EmptyState,
  Input,
  PageContainer,
  PageHeader,
  SectionHeader,
  Textarea,
} from "~/lib/ui";

export const Route = createFileRoute("/skills")({
  component: SkillsPage,
});

const listSkills = async (tx: ReadTransaction): Promise<SyncedSkill[]> => {
  const entries = await tx.scan({ prefix: IDB_KEY.SKILL({}) }).entries().toArray();
  return entries.map(([, v]) => v as unknown as SyncedSkill);
};

function SkillsPage() {
  const navigate = useNavigate();
  const { data: session } = authClient.useSession();
  const skills = useSubscribe(listSkills);

  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onCreate = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!name.trim() || !prompt.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const res = await client.api.skills.post({
        name: name.trim(),
        prompt: prompt.trim(),
      });
      if (res.error) {
        setError(edenErrorMessage(res.error, "Failed to create skill"));
        return;
      }
      setName("");
      setPrompt("");
      await navigate({ to: "/skills/$slug", params: { slug: res.data.slug } });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create skill");
    } finally {
      setCreating(false);
    }
  };

  if (!session?.user) {
    return (
      <PageContainer>
        <EmptyState
          icon={<Sparkles size={18} />}
          title="Not signed in"
          description="Sign in to create and manage skills."
          action={
            <a
              href="/login"
              className="text-sm underline text-muted-foreground hover:text-foreground"
            >
              Sign in
            </a>
          }
        />
      </PageContainer>
    );
  }

  const sorted = [...(skills ?? [])].sort((a, b) =>
    (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt),
  );

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Workspace"
        title="Skills"
        description="Long-lived prompts Alfred internalizes — preferences, biographical facts, working styles. Each becomes a skill body that's applied on every run."
      />

      <Card className="p-5 space-y-4">
        <SectionHeader
          title="New skill"
          description="Describe what Alfred should remember. The first revision is generated from this prompt plus your memory."
        />
        <form onSubmit={onCreate} className="space-y-3">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (e.g. Job search 2026)"
            maxLength={200}
          />
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should Alfred remember? Be specific — preferences, constraints, hard rules."
            maxLength={8_000}
            className="font-mono text-[12.5px] min-h-[120px]"
          />
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] text-muted-foreground tabular">
              {prompt.length}/8000
            </p>
            <Button
              type="submit"
              disabled={creating || !name.trim() || !prompt.trim()}
            >
              {creating ? "Learning…" : "Learn"}
            </Button>
          </div>
        </form>
      </Card>

      <section className="space-y-3">
        <SectionHeader title="Your skills" count={sorted.length} />
        {skills === undefined ? (
          <p className="text-sm text-muted-foreground px-1">Loading…</p>
        ) : sorted.length === 0 ? (
          <EmptyState
            icon={<Sparkles size={18} />}
            title="No skills yet"
            description="Author your first skill above. Alfred will turn it into a maintained brief."
          />
        ) : (
          <ul className="space-y-2">
            {sorted.map((skill) => (
              <li key={skill.id}>
                <Link
                  to="/skills/$slug"
                  params={{ slug: skill.slug }}
                  className="group block rounded-lg border bg-card px-4 py-3 shadow-soft hover:bg-accent/30 hover:border-foreground/20 transition-colors"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-medium truncate">{skill.name}</span>
                    <span className="flex items-center gap-2 shrink-0">
                      <SkillStatusPill status={skill.status} />
                      <ChevronRight
                        size={14}
                        className="text-muted-foreground group-hover:text-foreground transition-colors"
                      />
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground font-mono">
                    /{skill.slug}
                  </p>
                  {skill.description ? (
                    <p className="mt-1.5 text-[12.5px] text-muted-foreground line-clamp-2">
                      {skill.description}
                    </p>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </PageContainer>
  );
}
